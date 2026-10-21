import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  Alert,
  Button,
  ButtonLink,
  Cell,
  CellText,
  type ColumnConfig,
  Container,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Flex,
  Grid,
  Header,
  Link,
  Skeleton,
  Table,
  Text,
  TextField,
  useTable,
} from '@backstage/ui';
import {
  type BackupReachability,
  cnpgClusterCreatePermission,
  cnpgProjectDeletePermission,
  cnpgProjectUpdatePermission,
  type PostgresClusterSummary,
  type ProjectSummary,
} from '@internal/backstage-plugin-cnpg-common';
import { ReactNode, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { cnpgApiRef } from '../api';
import {
  auditRouteRef,
  clusterRouteRef,
  createClusterRouteRef,
  editProjectRouteRef,
  projectsRouteRef,
  volumesRouteRef,
} from '../routes';
import { ProjectBackupsPanel } from './Backups';
import {
  age,
  ErrorAlert,
  Fields,
  type Health,
  HealthBadge,
  Mono,
  Panel,
  ProjectHealthBadge,
  StatusDot,
} from './common';

type Row = PostgresClusterSummary & { id: string };

const ClusterTable = ({ clusters }: { clusters: PostgresClusterSummary[] }) => {
  const clusterLink = useRouteRef(clusterRouteRef);
  const columns: ColumnConfig<Row>[] = [
    {
      id: 'name',
      label: 'Name',
      isRowHeader: true,
      cell: c => (
        <CellText title={c.name} href={clusterLink?.({ namespace: c.namespace, name: c.name })} />
      ),
    },
    {
      id: 'status',
      label: 'Status',
      cell: c => (
        <Cell>
          <HealthBadge cluster={c} />
        </Cell>
      ),
    },
    {
      id: 'version',
      label: 'PostgreSQL',
      cell: c => <CellText title={c.postgresVersion ? String(c.postgresVersion) : '-'} />,
    },
    {
      id: 'instances',
      label: 'Instances',
      cell: c => <CellText title={`${c.readyInstances}/${c.instances}`} />,
    },
    {
      id: 'location',
      label: 'Location',
      cell: c => (
        <CellText
          title={c.primaryLocation || '-'}
          description={c.recoveryLocation ? `geo-replicated, ${c.primarySite} site primary` : undefined}
        />
      ),
    },
  ];
  const { tableProps } = useTable({
    mode: 'complete',
    data: clusters.map(c => ({ ...c, id: c.name })),
    paginationOptions: { pageSize: Math.max(clusters.length, 1) },
  });
  return (
    <Table
      columnConfig={columns}
      {...tableProps}
      pagination={{ type: 'none' }}
      emptyState={<Text color="secondary">No PostgreSQL clusters in this project yet.</Text>}
    />
  );
};

/** Grafana for browsers if there's an ingress, else the in-cluster URL. */
function grafanaField(summary: ProjectSummary, internalUrl?: string): ReactNode {
  if (summary.grafanaUrl) {
    return (
      <Link href={summary.grafanaUrl} target="_blank" rel="noopener noreferrer">
        {summary.grafanaUrl}
      </Link>
    );
  }
  if (!summary.grafana) return 'disabled';
  return internalUrl ? <Mono>{internalUrl}</Mono> : 'provisioning';
}

function prometheusField(summary: ProjectSummary, url?: string): ReactNode {
  if (url) return <Mono>{url}</Mono>;
  return summary.prometheus ? 'provisioning' : 'disabled';
}

const REACHABILITY: Record<BackupReachability['state'], { health: Health; label: string }> = {
  Reachable: { health: 'healthy', label: 'Reachable' },
  Unreachable: { health: 'unreachable', label: 'Unreachable' },
  Checking: { health: 'progressing', label: 'Checking again' },
  Pending: { health: 'progressing', label: 'Not checked yet' },
};

/**
 * Per location, whether it reaches the backup bucket: WAL archiving runs in
 * the locations, so each one checks from there, with its own keys.
 */
const BackupReachabilityPanel = ({ project }: { project: ProjectSummary }) => {
  const bucket = project.backupBucket!;
  return (
    <Panel title="Backup bucket reachability">
      <Flex direction="column" gap="3">
        {project.locations.map(location => {
          const site = location === project.protectedLocation ? 'protected' : 'recovery';
          const r = bucket.reachability.find(x => x.location === location);
          const mark = r ? REACHABILITY[r.state] : undefined;
          let detail: ReactNode;
          if (!r) {
            detail = bucket.ready
              ? 'The check starts with the next reconcile.'
              : 'The check starts once the bucket and this location\'s keys are in place.';
          } else if (r.state === 'Reachable') {
            detail = `Wrote, read back and deleted a test object ${age(r.lastSuccessTime)} ago.`;
          } else if (r.state === 'Pending') {
            detail = 'The first check runs within minutes.';
          } else {
            detail = (
              <>
                {r.state === 'Unreachable' ? `Last check ${age(r.lastCheckTime)} ago failed` : 'The last check failed'}
                {r.lastSuccessTime ? `; last success ${age(r.lastSuccessTime)} ago` : '; it never succeeded'}.
                {r.detail && (
                  <>
                    <br />
                    <Mono>{r.detail}</Mono>
                  </>
                )}
              </>
            );
          }
          return (
            <Flex key={location} direction="column" gap="1">
              <Flex gap="3" align="center">
                <Text weight="bold">
                  {location} ({site})
                </Text>
                {mark ? (
                  <StatusDot health={mark.health} label={mark.label} />
                ) : (
                  <StatusDot health="progressing" label="Waiting" />
                )}
              </Flex>
              <Text variant="body-small" color="secondary" style={{ overflowWrap: 'anywhere' }}>
                {detail}
              </Text>
            </Flex>
          );
        })}
        <Text variant="body-x-small" color="secondary">
          The backup-check CronJob in each location's {project.name} namespace tests what WAL archiving
          (write) and a replica cluster (read) need, every few minutes.
        </Text>
      </Flex>
    </Panel>
  );
};

/**
 * Deletes an empty project; while it has clusters it only says so (the
 * backend refuses too). The backend turns deletion protection off for it.
 */
const DeleteDialog = ({
  project,
  clusters,
  isOpen,
  onOpenChange,
}: {
  project: ProjectSummary;
  clusters: string[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const api = useApi(cnpgApiRef);
  const navigate = useNavigate();
  const listLink = useRouteRef(projectsRouteRef);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<Error>();
  const [pending, setPending] = useState(false);
  const { name } = project;

  const onDelete = async () => {
    setPending(true);
    try {
      await api.deleteProject(name);
      onOpenChange(false);
      navigate(listLink?.() ?? '/cnpg/projects');
    } catch (e) {
      setError(e as Error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={520}>
      <DialogHeader>Delete project {name}?</DialogHeader>
      <DialogBody>
        {clusters.length > 0 ? (
          <Text>
            Project {name} still has {clusters.length} PostgreSQL cluster
            {clusters.length > 1 ? 's' : ''}: {clusters.join(', ')}. Delete{' '}
            {clusters.length > 1 ? 'them' : 'it'} first; deleting the project would delete every
            database in it.
          </Text>
        ) : (
          <Flex direction="column" gap="3">
            <Text>
              Deletes namespace {name} on the control plane with its Prometheus, Grafana and the
              metrics in them, and the project's access bindings.
              {project.deletionProtection && ' Its deletion protection is turned off for this.'}
            </Text>
            {project.locations.length > 0 && (
              <Text color="secondary">
                The namespace in {project.locations.join(' and ')} stays, with anything still in it;
                delete it there when it's empty.
              </Text>
            )}
            <TextField label={`Type "${name}" to confirm`} value={confirm} onChange={setConfirm} />
            {error && <ErrorAlert error={error} />}
          </Flex>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onPress={() => onOpenChange(false)}>
          {clusters.length ? 'Close' : 'Cancel'}
        </Button>
        <Button
          variant="primary"
          destructive
          isDisabled={clusters.length > 0 || confirm !== name}
          loading={pending}
          onPress={onDelete}
        >
          Delete
        </Button>
      </DialogFooter>
    </Dialog>
  );
};

/** One project: its observability endpoints, settings and the clusters in it. */
export const ProjectDetailPage = () => {
  const { name = '' } = useParams();
  const api = useApi(cnpgApiRef);
  const createClusterLink = useRouteRef(createClusterRouteRef);
  const editLink = useRouteRef(editProjectRouteRef);
  const volumesLink = useRouteRef(volumesRouteRef);
  const auditLink = useRouteRef(auditRouteRef);
  const { allowed: canCreateCluster } = usePermission({ permission: cnpgClusterCreatePermission });
  const { allowed: canUpdate } = usePermission({ permission: cnpgProjectUpdatePermission });
  const { allowed: canDelete } = usePermission({ permission: cnpgProjectDeletePermission });
  const [deleting, setDeleting] = useState(false);

  const { value, error, retry } = useAsyncRetry(async () => {
    const [project, clusters] = await Promise.all([
      api.getProject(name),
      api.listClusters(name),
    ]);
    return { ...project, clusters };
  }, [api, name]);
  useInterval(retry, 15_000);

  const summary = value?.summary;
  const spec = value?.resource.spec;
  const status = value?.resource.status;

  return (
    <>
      <Header
        title={name}
        tags={[{ label: 'project' }]}
        customActions={
          <Flex gap="3" align="center">
            {summary && <ProjectHealthBadge project={summary} />}
            {volumesLink && (
              <ButtonLink href={`${volumesLink()}?project=${encodeURIComponent(name)}`} variant="secondary">
                Volumes
              </ButtonLink>
            )}
            {auditLink && (
              <ButtonLink href={`${auditLink()}?project=${encodeURIComponent(name)}`} variant="secondary">
                Audit logs
              </ButtonLink>
            )}
            {canUpdate && editLink && summary && !summary.deleting && (
              <ButtonLink href={editLink({ name })} variant="secondary">
                Edit
              </ButtonLink>
            )}
            {canDelete && summary && !summary.deleting && (
              <Button variant="secondary" destructive onPress={() => setDeleting(true)}>
                Delete
              </Button>
            )}
            {canCreateCluster && createClusterLink && (
              <ButtonLink
                href={`${createClusterLink()}?project=${encodeURIComponent(name)}`}
                variant="primary"
              >
                Create cluster here
              </ButtonLink>
            )}
          </Flex>
        }
      />
      <Container>
        {error && !value && <ErrorAlert error={error} />}
        {!error && !value && <Skeleton width="100%" height={240} />}
        {value && summary && (
          <Flex direction="column" gap="4">
            {!summary.ready && (
              <Alert
                status="info"
                title="Provisioning"
                description={summary.message ?? 'Waiting for Prometheus and Grafana.'}
              />
            )}
            <Grid.Root columns={{ initial: '1', md: '2' }} gap="4">
              <Panel title="Project">
                <Fields
                  rows={[
                    ['Owner', summary.owner ?? '-'],
                    ['Description', summary.description ?? '-'],
                    ...(['protected', 'recovery'] as const).map(site => {
                      const location = site === 'protected' ? summary.protectedLocation : summary.recoveryLocation;
                      const l = status?.locations?.find(s => s.location === location);
                      let text = location ?? (site === 'recovery' ? 'none: no geo replication' : '-');
                      if (location && l) text = `${location} (${l.ready ? 'ready' : l.message ?? 'provisioning'})`;
                      return [`${site === 'protected' ? 'Protected' : 'Recovery'} location`, text] as [string, ReactNode];
                    }),
                    [
                      'Access',
                      spec?.access?.length
                        ? spec.access.map(a => `${a.group} (${a.role})`).join(', ')
                        : '-',
                    ],
                    [
                      'Quota',
                      spec?.quota
                        ? [
                            spec.quota.cpu && `cpu ${spec.quota.cpu}`,
                            spec.quota.memory && `memory ${spec.quota.memory}`,
                            spec.quota.storage && `storage ${spec.quota.storage}`,
                          ]
                            .filter(Boolean)
                            .join(', ')
                        : 'none',
                    ],
                    [
                      'Backup bucket',
                      summary.backupBucket
                        ? `${summary.backupBucket.bucket ?? 'provisioning'}${summary.backupBucket.ready ? '' : ' (not ready)'}: databases without a backup destination of their own archive here`
                        : 'none (no COSI classes in project-defaults, or spec.backup.bucket: false)',
                    ],
                    [
                      'Deletion protection',
                      summary.deletionProtection ? 'on' : 'off: deleting the project deletes its databases',
                    ],
                  ]}
                />
              </Panel>
              <Panel title="Observability">
                <Fields
                  rows={[
                    ['Grafana', grafanaField(summary, status?.grafana?.internalUrl)],
                    [
                      'Grafana admin',
                      status?.grafana?.adminSecret ? (
                        <Mono>{`${name}/${status.grafana.adminSecret}`}</Mono>
                      ) : (
                        '-'
                      ),
                    ],
                    ['Prometheus', prometheusField(summary, status?.prometheus?.url)],
                    ...(summary.locations.length > 0
                      ? [
                          [
                            'Locations',
                            status?.prometheus?.remoteWriteUrl ? (
                              <Mono>remote write to {status.prometheus.remoteWriteUrl}</Mono>
                            ) : (
                              'metrics stay in each location; Grafana shows none (no remote write configured)'
                            ),
                          ] as [string, ReactNode],
                        ]
                      : []),
                    ['Retention', spec?.observability?.prometheus?.retention ?? '-'],
                  ]}
                />
              </Panel>
            </Grid.Root>
            {summary.backupBucket && summary.locations.length > 0 && (
              <BackupReachabilityPanel project={summary} />
            )}
            <Panel title="PostgreSQL clusters">
              <ClusterTable clusters={value.clusters} />
            </Panel>
            {summary.backupBucket && (
              <ProjectBackupsPanel
                project={name}
                servers={status?.backup?.servers ?? []}
                clusters={value.clusters.map(c => c.name)}
              />
            )}
          </Flex>
        )}
      </Container>
      {value && summary && (
        <DeleteDialog
          project={summary}
          clusters={value.clusters.map(c => c.name)}
          isOpen={deleting}
          onOpenChange={setDeleting}
        />
      )}
    </>
  );
};
