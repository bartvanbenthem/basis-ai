import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  Alert,
  Button,
  Cell,
  CellText,
  type ColumnConfig,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Flex,
  Select,
  Table,
  Text,
  TextField,
  useTable,
} from '@backstage/ui';
import {
  type BackupServer,
  clusterRestoreSource,
  cnpgClusterCreatePermission,
  cnpgClusterRestorePermission,
  type PostgresClusterDetails,
  type RestoreSource,
  serverRestoreSource,
  targetTimeError,
} from '@internal/backstage-plugin-cnpg-common';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cnpgApiRef, type RestoreRequest } from '../api';
import { clusterRouteRef } from '../routes';
import { age, ErrorAlert, Fields, Mono, Panel, StatusDot } from './common';

// Same rule as the backend (CNPG's derived names must fit).
const NAME = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const SIZE = /^[0-9]+(Mi|Gi|Ti)$/;

/** "2026-10-08T09:30:00Z (3h ago)" */
const when = (timestamp?: string) => (timestamp ? `${timestamp} (${age(timestamp)} ago)` : undefined);

/** Now, to the second, as the target time field's starting value. */
const nowUtc = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

/** A name for the copy that still fits: "<source>-restore", cut to 40 characters. */
const copyName = (source: string) => `${source.slice(0, 32).replace(/-+$/, '')}-restore`;

/** Restores a backup folder into a new cluster in `project`, then opens it. */
const RestoreDialog = ({
  project,
  from,
  source,
  storageSize,
  onClose,
}: {
  project: string;
  from: RestoreRequest['from'];
  source: RestoreSource;
  storageSize: string;
  onClose: () => void;
}) => {
  const api = useApi(cnpgApiRef);
  const navigate = useNavigate();
  const clusterLink = useRouteRef(clusterRouteRef);
  const [name, setName] = useState(copyName(source.cluster ?? source.serverName));
  const [mode, setMode] = useState<'latest' | 'time'>('latest');
  const [targetTime, setTargetTime] = useState(nowUtc);
  const [size, setSize] = useState(storageSize);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error>();
  const target = mode === 'time' ? targetTime.trim() : undefined;
  const nameError = NAME.test(name) ? undefined : 'lowercase letters, digits and "-", max 40 characters';
  const timeError = targetTimeError(source, target);
  const sizeError = SIZE.test(size) ? undefined : 'e.g. 20Gi';

  const submit = async () => {
    setPending(true);
    setError(undefined);
    try {
      await api.restoreCluster(project, { name, from, targetTime: target, storageSize: size });
      onClose();
      navigate(clusterLink?.({ namespace: project, name }) ?? `/cnpg/${project}/${name}`);
    } catch (e) {
      setError(e as Error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog isOpen onOpenChange={open => !open && onClose()} width={600}>
      <DialogHeader>Restore {source.serverName} into a new cluster</DialogHeader>
      <DialogBody>
        <Flex direction="column" gap="3">
          <Text>
            A new cluster in project {project} starts from this backup folder and replays its WAL
            archive up to the moment you choose. The backups are only read: {source.cluster ?? 'the source'}{' '}
            keeps running untouched, and the new cluster archives to a folder of its own.
          </Text>
          {!source.firstRecoverabilityPoint && (
            <Alert
              status="warning"
              title="No base backup reported for this folder"
              description="The restore fails if the folder holds no base backup yet (the first one runs right after a cluster is created)."
            />
          )}
          <Fields
            rows={[
              ['Recoverable from', when(source.firstRecoverabilityPoint) ?? 'unknown'],
              ['Last base backup', when(source.lastSuccessfulBackup) ?? 'unknown'],
              ['PostgreSQL', source.postgresVersion ? String(source.postgresVersion) : 'as the source'],
              ['Database', source.database?.name ? `${source.database.name} (owner ${source.database.owner ?? source.database.name})` : 'as the source'],
            ]}
          />
          <TextField
            label="New cluster name"
            isRequired
            value={name}
            onChange={setName}
            description={nameError ?? 'Applications connect to it under this name; the source keeps its own.'}
          />
          <Select
            label="Restore to"
            value={mode}
            onChange={k => setMode(k === 'time' ? 'time' : 'latest')}
            options={[
              { id: 'latest', label: 'The latest state (all archived WAL)' },
              { id: 'time', label: 'A point in time' },
            ]}
          />
          {mode === 'time' && (
            <TextField
              label="Target time (UTC, RFC 3339)"
              value={targetTime}
              onChange={setTargetTime}
              description={timeError ?? 'Transactions committed after this moment are left out.'}
            />
          )}
          <TextField
            label="Storage size"
            value={size}
            onChange={setSize}
            description={sizeError ?? 'At least what the source used.'}
          />
          {error && <ErrorAlert error={error} />}
        </Flex>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          isDisabled={Boolean(nameError || timeError || sizeError)}
          loading={pending}
          onPress={submit}
        >
          Restore
        </Button>
      </DialogFooter>
    </Dialog>
  );
};

function useCanRestore() {
  const { allowed: canCreate } = usePermission({ permission: cnpgClusterCreatePermission });
  const { allowed: canRestore } = usePermission({ permission: cnpgClusterRestorePermission });
  return canCreate && canRestore;
}

/**
 * The Backups tab of a cluster: where it archives, what can be restored,
 * and restoring that into a new cluster (never over this one).
 */
export const ClusterBackups = ({ details }: { details: PostgresClusterDetails }) => {
  const canRestore = useCanRestore();
  const [open, setOpen] = useState(false);
  const { resource, summary } = details;
  const { spec, status } = resource;
  const backup = spec.backup ?? {};
  const source = clusterRestoreSource(resource);
  const restoredFrom = spec.restore?.source?.serverName as string | undefined;

  return (
    <Flex direction="column" gap="4">
      {!backup.enabled && (
        <Alert
          status="info"
          title="Backups are off"
          description="Turn them on in Edit: continuous WAL archiving and scheduled base backups, to the project's backup bucket unless you name a store of your own."
        />
      )}
      {backup.enabled && (
        <Panel title="Backups">
          <Fields
            rows={[
              [
                'Store',
                backup.destinationPath ? (
                  <Mono>{backup.destinationPath}</Mono>
                ) : (
                  <>
                    the project's backup bucket
                    {status?.backupStore?.destinationPath && (
                      <>
                        {' '}
                        <Mono>{status.backupStore.destinationPath}</Mono>
                      </>
                    )}
                  </>
                ),
              ],
              ['Folder', status?.backup?.serverName ? <Mono>{status.backup.serverName}</Mono> : 'not reported yet'],
              ['Schedule', <Mono>{backup.schedule ?? '0 0 2 * * *'}</Mono>],
              ['Retention', backup.retentionPolicy ?? '30d'],
              ['Last base backup', when(status?.backup?.lastSuccessfulBackup) ?? 'none yet'],
              ['Recoverable from', when(status?.backup?.firstRecoverabilityPoint) ?? '-'],
              ...(summary.primarySite === 'recovery'
                ? [
                    [
                      'Primary in the recovery site',
                      'The folder is the replica cluster\'s: it has base backups only from after the switchover.',
                    ] as [string, string],
                  ]
                : []),
            ]}
          />
        </Panel>
      )}
      {restoredFrom && (
        <Panel title="Restored from">
          <Fields
            rows={[
              ['Backup folder', <Mono>{restoredFrom}</Mono>],
              ['Up to', spec.restore?.targetTime ?? 'the latest state'],
            ]}
          />
        </Panel>
      )}
      <Panel title="Restore">
        <Flex justify="between" align="center" gap="4">
          <Text variant="body-small">
            {'error' in source
              ? `Nothing to restore: ${source.error}.`
              : 'Creates a new cluster from these backups, up to a point in time or the latest state. This cluster is not changed.'}
          </Text>
          {canRestore && !('error' in source) && (
            <Button variant="primary" onPress={() => setOpen(true)}>
              Restore to a new cluster
            </Button>
          )}
        </Flex>
      </Panel>
      {open && !('error' in source) && (
        <RestoreDialog
          project={summary.namespace}
          from={{ cluster: summary.name }}
          source={source}
          storageSize={spec.storage?.size ?? '10Gi'}
          onClose={() => setOpen(false)}
        />
      )}
    </Flex>
  );
};

type ServerRow = BackupServer & { id: string };

/**
 * A project's backup folders, from its inventory of the bucket: the live
 * clusters' and those of clusters deleted since, which can only be restored
 * from here.
 */
export const ProjectBackupsPanel = ({
  project,
  servers,
  clusters,
}: {
  project: string;
  servers: BackupServer[];
  /** Clusters in the project now, to link to and copy settings from. */
  clusters: string[];
}) => {
  const canRestore = useCanRestore();
  const clusterLink = useRouteRef(clusterRouteRef);
  const [restoring, setRestoring] = useState<BackupServer>();
  const columns: ColumnConfig<ServerRow>[] = [
    {
      id: 'folder',
      label: 'Folder',
      isRowHeader: true,
      cell: s => <CellText title={s.serverName} description={s.location} />,
    },
    {
      id: 'cluster',
      label: 'Cluster',
      cell: s =>
        s.active && s.cluster && clusters.includes(s.cluster) ? (
          <CellText title={s.cluster} href={clusterLink?.({ namespace: project, name: s.cluster })} />
        ) : (
          <CellText title={s.cluster ?? '-'} description={s.active ? undefined : 'deleted'} />
        ),
    },
    {
      id: 'state',
      label: 'State',
      cell: s => (
        <Cell>
          <StatusDot
            health={s.active ? 'healthy' : 'deleting'}
            label={s.active ? 'Archiving' : 'Kept (cluster gone)'}
          />
        </Cell>
      ),
    },
    {
      id: 'version',
      label: 'PostgreSQL',
      cell: s => <CellText title={s.postgresVersion ? String(s.postgresVersion) : '-'} />,
    },
    {
      id: 'window',
      label: 'Recoverable from',
      cell: s => (
        <CellText
          title={s.firstRecoverabilityPoint ?? 'no base backup reported'}
          description={s.lastSuccessfulBackup ? `last base backup ${age(s.lastSuccessfulBackup)} ago` : undefined}
        />
      ),
    },
    ...(canRestore
      ? [
          {
            id: 'restore',
            label: '',
            cell: (s: ServerRow) => (
              <Cell>
                <Button size="small" variant="secondary" onPress={() => setRestoring(s)}>
                  Restore
                </Button>
              </Cell>
            ),
          },
        ]
      : []),
  ];
  const { tableProps } = useTable({
    mode: 'complete',
    data: servers.map(s => ({ ...s, id: s.serverName })),
    paginationOptions: { pageSize: Math.max(servers.length, 1) },
  });
  return (
    <Panel title="Backups">
      <Flex direction="column" gap="3">
        <Table
          columnConfig={columns}
          {...tableProps}
          pagination={{ type: 'none' }}
          emptyState={<Text color="secondary">No cluster has archived to the bucket yet.</Text>}
        />
        <Text variant="body-x-small" color="secondary">
          Every cluster site archives to a folder of its own in the project's bucket. Folders stay
          after their cluster is deleted; restoring one creates a new cluster.
        </Text>
      </Flex>
      {restoring && (
        <RestoreDialog
          project={project}
          from={{ serverName: restoring.serverName }}
          source={serverRestoreSource(restoring)}
          storageSize="10Gi"
          onClose={() => setRestoring(undefined)}
        />
      )}
    </Panel>
  );
};
