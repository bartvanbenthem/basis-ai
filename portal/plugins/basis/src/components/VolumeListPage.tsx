import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  Alert,
  Button,
  Cell,
  CellText,
  type ColumnConfig,
  Container,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Flex,
  Header,
  Link,
  Select,
  Table,
  Text,
  TextField,
  useTable,
} from '@backstage/ui';
import {
  cnpgVolumeDeletePermission,
  isOrphanedVolume,
  quantityBytes,
  type VolumeSummary,
} from '@internal/backstage-plugin-cnpg-common';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { cnpgApiRef } from '../api';
import { clusterRouteRef, projectRouteRef } from '../routes';
import { age, bytes, ErrorAlert, Mono, VolumeStateBadge } from './common';

type Row = VolumeSummary & { id: string };
type Filter = 'all' | 'in-use' | 'orphaned';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All volumes' },
  { id: 'orphaned', label: 'Orphaned' },
  { id: 'in-use', label: 'In use' },
];
const ALL = '__all__';

const rowId = (v: VolumeSummary) =>
  `${v.location}/${v.project}/${v.claim}/${v.volume ?? ''}`;
const sizeOf = (v: VolumeSummary) =>
  v.capacityBytes ?? quantityBytes(v.capacity) ?? 0;

/** "4.1 GiB (21%)" from the kubelet's numbers; "-" when it isn't mounted. */
function usedText(v: VolumeSummary): string {
  if (v.usedBytes === undefined) return '-';
  const total = v.capacityBytes ?? quantityBytes(v.capacity);
  return total
    ? `${bytes(v.usedBytes)} (${Math.round((v.usedBytes / total) * 100)}%)`
    : bytes(v.usedBytes);
}

/** Deletes an orphaned claim or released volume with its storage, after typing its claim name. */
const DeleteDialog = ({
  volume,
  onClose,
  onDeleted,
}: {
  volume: VolumeSummary;
  onClose: () => void;
  onDeleted: () => void;
}) => {
  const api = useApi(cnpgApiRef);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<Error>();
  const [pending, setPending] = useState(false);

  const onDelete = async () => {
    setPending(true);
    setError(undefined);
    try {
      await api.deleteVolume(volume);
      onDeleted();
    } catch (e) {
      setError(e as Error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog isOpen onOpenChange={open => !open && onClose()} width={560}>
      <DialogHeader>Delete volume?</DialogHeader>
      <DialogBody>
        <Flex direction="column" gap="3">
          <Text>
            {volume.state === 'released' ? (
              <>
                Deletes released volume <Mono>{volume.volume}</Mono> in{' '}
                {volume.location}, once claim{' '}
                <Mono>
                  {volume.project}/{volume.claim}
                </Mono>
              </>
            ) : (
              <>
                Deletes claim{' '}
                <Mono>
                  {volume.project}/{volume.claim}
                </Mono>{' '}
                in {volume.location}
                {volume.volume && (
                  <>
                    {' '}
                    and its volume <Mono>{volume.volume}</Mono>
                  </>
                )}
              </>
            )}
            , with the {volume.capacity ?? ''} disk behind it. This can't be
            undone.
          </Text>
          {volume.cluster && (
            <Text color="secondary">
              It holds {volume.role === 'wal' ? 'WAL' : 'data'} of deleted
              cluster {volume.cluster}
              {volume.instance ? ` (instance ${volume.instance})` : ''}:
              anything not in the backup bucket is lost.
            </Text>
          )}
          {volume.reclaimPolicy === 'Retain' && (
            <Text color="secondary">
              Its reclaim policy is Retain: the portal switches it to Delete, so
              the storage goes too.
            </Text>
          )}
          <TextField
            label="Type the claim name to confirm"
            value={confirm}
            onChange={setConfirm}
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
          destructive
          isDisabled={confirm !== volume.claim}
          loading={pending}
          onPress={onDelete}
        >
          Delete
        </Button>
      </DialogFooter>
    </Dialog>
  );
};

/**
 * The disks of PostgreSQL instances: CNPG's claims in each project's
 * namespace in every location it uses, and released volumes they left behind.
 * The project filter lives in ?project=<name> so a project can link to it.
 */
export const VolumeListPage = () => {
  const api = useApi(cnpgApiRef);
  const projectLink = useRouteRef(projectRouteRef);
  const clusterLink = useRouteRef(clusterRouteRef);
  const { allowed: canDelete } = usePermission({
    permission: cnpgVolumeDeletePermission,
  });
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<Filter>('all');
  const [location, setLocation] = useState(ALL);
  const [deleting, setDeleting] = useState<VolumeSummary>();
  const project = params.get('project') ?? ALL;

  const { value, loading, error, retry } = useAsyncRetry(
    () => api.listVolumes(),
    [api],
  );
  // Usage comes from the kubelets; the backend caches it for a minute.
  useInterval(retry, 60_000);

  const all = useMemo(() => value?.items ?? [], [value]);
  // A linked project keeps its option while it has no volumes.
  const projects = useMemo(
    () =>
      [
        ...new Set([
          ...all.map(v => v.project),
          ...(project === ALL ? [] : [project]),
        ]),
      ].sort(),
    [all, project],
  );
  const locations = useMemo(
    () => [...new Set(all.map(v => v.location))].sort(),
    [all],
  );
  const scoped = useMemo(
    () =>
      all.filter(
        v =>
          (project === ALL || v.project === project) &&
          (location === ALL || v.location === location),
      ),
    [all, project, location],
  );
  const rows: Row[] = useMemo(
    () =>
      scoped
        .filter(
          v =>
            filter === 'all' ||
            (filter === 'orphaned'
              ? isOrphanedVolume(v.state)
              : v.state === 'in-use'),
        )
        .map(v => ({ ...v, id: rowId(v) })),
    [scoped, filter],
  );
  const stats = useMemo(() => {
    const sum = (items: VolumeSummary[]) =>
      bytes(items.reduce((n, v) => n + sizeOf(v), 0));
    const inUse = scoped.filter(v => v.state === 'in-use');
    const orphaned = scoped.filter(v => isOrphanedVolume(v.state));
    const mounted = scoped.filter(v => v.usedBytes !== undefined);
    const used = mounted.reduce((n, v) => n + (v.usedBytes ?? 0), 0);
    const ofMounted = mounted.reduce((n, v) => n + sizeOf(v), 0);
    return [
      {
        label: 'Volumes',
        value: scoped.length,
        hint: `${sum(scoped)} provisioned`,
      },
      {
        label: 'In use',
        value: inUse.length,
        hint: `${sum(inUse)} by running instances`,
      },
      {
        label: 'Orphaned',
        value: orphaned.length,
        hint: `${sum(orphaned)}; their cluster is gone`,
      },
      {
        label: 'Used',
        value: ofMounted ? `${Math.round((used / ofMounted) * 100)}%` : '-',
        hint: `${bytes(used)} of ${bytes(ofMounted)} on mounted volumes`,
      },
    ];
  }, [scoped]);

  const columns: ColumnConfig<Row>[] = [
    {
      id: 'claim',
      label: 'Volume claim',
      isRowHeader: true,
      cell: v => <CellText title={v.claim} description={v.volume} />,
    },
    {
      id: 'state',
      label: 'Status',
      cell: v => (
        <Cell>
          <Flex direction="column" gap="1">
            <VolumeStateBadge state={v.state} />
            {v.phase !== 'Bound' && v.state !== 'released' && (
              <Text variant="body-small" color="secondary">
                {v.phase}
              </Text>
            )}
          </Flex>
        </Cell>
      ),
    },
    {
      id: 'project',
      label: 'Project',
      cell: v => (
        <Cell>
          <Link href={projectLink?.({ name: v.project })}>{v.project}</Link>
        </Cell>
      ),
    },
    {
      id: 'cluster',
      label: 'Cluster',
      cell: v => (
        <Cell>
          <Flex direction="column" gap="1">
            {v.cluster && v.state === 'in-use' ? (
              <Link
                href={clusterLink?.({ namespace: v.project, name: v.cluster })}
              >
                {v.cluster}
              </Link>
            ) : (
              <Text variant="body-small" color="secondary">
                {v.cluster ? `${v.cluster} (deleted)` : '-'}
              </Text>
            )}
            {v.role && (
              <Text variant="body-small" color="secondary">
                {v.instance} ·{' '}
                {v.role === 'tablespace'
                  ? `tablespace ${v.tablespace ?? ''}`
                  : v.role}
              </Text>
            )}
          </Flex>
        </Cell>
      ),
    },
    {
      id: 'location',
      label: 'Location',
      cell: v => <CellText title={v.location} description={v.node} />,
    },
    {
      id: 'size',
      label: 'Size',
      cell: v => (
        <CellText
          title={v.capacity ?? v.requested ?? '-'}
          description={
            v.resizing ||
            (v.requested && v.capacity && v.requested !== v.capacity)
              ? `resizing to ${v.requested}`
              : undefined
          }
        />
      ),
    },
    { id: 'used', label: 'Used', cell: v => <CellText title={usedText(v)} /> },
    {
      id: 'storage',
      label: 'Storage class',
      cell: v => (
        <CellText
          title={v.storageClass ?? '-'}
          description={v.reclaimPolicy && `reclaim: ${v.reclaimPolicy}`}
        />
      ),
    },
    {
      id: 'age',
      label: 'Age',
      cell: v => <CellText title={age(v.createdAt)} />,
    },
    {
      id: 'actions',
      label: '',
      cell: v => (
        <Cell>
          {canDelete && isOrphanedVolume(v.state) && (
            <Button
              size="small"
              variant="secondary"
              destructive
              onPress={() => {
                const { id: _id, ...volume } = v;
                setDeleting(volume);
              }}
            >
              Delete
            </Button>
          )}
        </Cell>
      ),
    },
  ];

  const { tableProps } = useTable({
    mode: 'complete',
    data: rows,
    paginationOptions: { pageSize: 25 },
  });

  const option = (label: string) => (id: string) => ({
    id,
    label: id === ALL ? label : id,
  });

  return (
    <>
      <Header
        title="Volumes"
        description="The disks of PostgreSQL instances in every project and location, including those of deleted clusters"
      />
      <Container>
        <Flex direction="column" gap="4">
          {error && <ErrorAlert error={error} />}
          {value?.unreachable?.map(u => (
            <Alert
              key={u.location}
              status="warning"
              title={`Location ${u.location} unreachable`}
              description={`Its volumes are missing: ${u.message}`}
            />
          ))}
          <div className="tp-stats">
            {stats.map(s => (
              <div key={s.label} className="tp-stat">
                <div className="tp-stat__label">{s.label}</div>
                <div className="tp-stat__value">{value ? s.value : '…'}</div>
                <div className="tp-stat__hint">{s.hint}</div>
              </div>
            ))}
          </div>
          <Flex gap="3" align="end">
            <Select
              label="Show"
              value={filter}
              onChange={key => setFilter((key as Filter) ?? 'all')}
              options={FILTERS}
            />
            <Select
              label="Project"
              value={project}
              onChange={key => {
                const next = new URLSearchParams(params);
                if (!key || key === ALL) next.delete('project');
                else next.set('project', String(key));
                setParams(next, { replace: true });
              }}
              options={[ALL, ...projects].map(option('All projects'))}
            />
            <Select
              label="Location"
              value={location}
              onChange={key => setLocation(String(key ?? ALL))}
              options={[ALL, ...locations].map(option('All locations'))}
            />
          </Flex>
          <Table
            columnConfig={columns}
            {...tableProps}
            loading={loading && !value}
            emptyState={
              <Text color="secondary">
                {filter === 'orphaned'
                  ? 'No orphaned volumes.'
                  : 'No volumes of PostgreSQL instances.'}
              </Text>
            }
          />
        </Flex>
      </Container>
      {deleting && (
        <DeleteDialog
          volume={deleting}
          onClose={() => setDeleting(undefined)}
          onDeleted={() => {
            setDeleting(undefined);
            retry();
          }}
        />
      )}
    </>
  );
};
