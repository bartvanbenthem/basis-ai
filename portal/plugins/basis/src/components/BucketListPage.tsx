import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import {
  Alert,
  Cell,
  CellText,
  type ColumnConfig,
  Container,
  Flex,
  Header,
  Link,
  Select,
  Table,
  Text,
  useTable,
} from '@backstage/ui';
import type {
  BucketState,
  BucketSummary,
} from '@internal/backstage-plugin-cnpg-common';
import { useMemo, useState } from 'react';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { cnpgApiRef } from '../api';
import { bucketRouteRef, projectRouteRef } from '../routes';
import { age, BucketStateBadge, bytes, ErrorAlert, usageText } from './common';

type Row = BucketSummary & { id: string };
type Filter = 'all' | BucketState;

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All buckets' },
  { id: 'orphaned', label: 'Orphaned' },
  { id: 'project', label: 'In use by a project' },
  { id: 'cosi', label: 'COSI claim' },
];

/**
 * Every bucket on the object store account COSI provisions with, including
 * orphaned ones; only those the cluster knows when the store can't be read.
 */
export const BucketListPage = () => {
  const api = useApi(cnpgApiRef);
  const bucketLink = useRouteRef(bucketRouteRef);
  const projectLink = useRouteRef(projectRouteRef);
  const [filter, setFilter] = useState<Filter>('all');

  const { value, loading, error, retry } = useAsyncRetry(
    () => api.listBuckets(),
    [api],
  );
  // Sizes are counted by listing every object: the backend caches them for a minute.
  useInterval(retry, 60_000);

  const all = useMemo(() => value?.items ?? [], [value]);
  const rows: Row[] = useMemo(
    () =>
      all
        .filter(b => filter === 'all' || b.state === filter)
        .map(b => ({ ...b, id: b.name })),
    [all, filter],
  );
  const stats = useMemo(() => {
    const sum = (items: BucketSummary[]) =>
      bytes(items.reduce((n, b) => n + (b.usage?.bytes ?? 0), 0));
    const of = (state: BucketState) => all.filter(b => b.state === state);
    return [
      { label: 'Buckets', value: all.length, hint: `${sum(all)} in total` },
      {
        label: 'In use',
        value: of('project').length,
        hint: `${sum(of('project'))} of project backups`,
      },
      {
        label: 'Orphaned',
        value: of('orphaned').length,
        hint: `${sum(of('orphaned'))}; nothing on the cluster uses them`,
      },
      {
        label: 'COSI claims',
        value: of('cosi').length,
        hint: 'a BucketClaim outside a project',
      },
    ];
  }, [all]);

  const columns: ColumnConfig<Row>[] = [
    {
      id: 'name',
      label: 'Bucket',
      isRowHeader: true,
      cell: b => (
        <CellText title={b.name} href={bucketLink?.({ name: b.name })} />
      ),
    },
    {
      id: 'state',
      label: 'Status',
      cell: b => (
        <Cell>
          <BucketStateBadge state={b.state} />
        </Cell>
      ),
    },
    {
      id: 'project',
      label: 'Project',
      cell: b => (
        <Cell>
          {b.project ? (
            <Link href={projectLink?.({ name: b.project })}>{b.project}</Link>
          ) : (
            <Text variant="body-small" color="secondary">
              {b.formerProject ? `${b.formerProject} (deleted)` : '-'}
            </Text>
          )}
        </Cell>
      ),
    },
    {
      id: 'objects',
      label: 'Objects',
      cell: b => (
        <CellText
          title={b.usageError ? 'unknown' : usageText(b.usage).objects}
          description={b.usageError}
        />
      ),
    },
    {
      id: 'size',
      label: 'Size',
      cell: b => <CellText title={usageText(b.usage).size} />,
    },
    {
      id: 'written',
      label: 'Last write',
      cell: b => <CellText title={age(b.usage?.lastModified)} />,
    },
    {
      id: 'age',
      label: 'Age',
      cell: b => <CellText title={age(b.createdAt)} />,
    },
  ];

  const { tableProps } = useTable({
    mode: 'complete',
    data: rows,
    paginationOptions: { pageSize: 25 },
  });

  return (
    <>
      <Header
        title="Buckets"
        description="Every bucket on the object store account COSI provisions with, including those of deleted projects"
      />
      <Container>
        <Flex direction="column" gap="4">
          {error && <ErrorAlert error={error} />}
          {value && !value.configured && (
            <Alert
              status="info"
              title="No object store configured"
              description="Showing the buckets the cluster refers to. Set cnpg.buckets in the portal's app-config (the S3 endpoint and the COSI driver's credentials Secret) for their usage and orphaned buckets."
            />
          )}
          {value?.configured && value.storeError && (
            <Alert
              status="warning"
              title="Object store unreachable"
              description={`Showing the buckets the cluster refers to, without usage; orphaned buckets can't be listed. ${value.storeError}`}
            />
          )}
          {value?.configured !== false && !value?.storeError && (
            <div className="tp-stats">
              {stats.map(s => (
                <div key={s.label} className="tp-stat">
                  <div className="tp-stat__label">{s.label}</div>
                  <div className="tp-stat__value">{value ? s.value : '…'}</div>
                  <div className="tp-stat__hint">{s.hint}</div>
                </div>
              ))}
            </div>
          )}
          {value && (
            <Flex gap="3" align="end">
              <Select
                label="Show"
                value={filter}
                onChange={key => setFilter((key as Filter) ?? 'all')}
                options={FILTERS}
              />
            </Flex>
          )}
          <Table
            columnConfig={columns}
            {...tableProps}
            loading={loading && !value}
            emptyState={
              <Text color="secondary">
                {filter === 'all'
                  ? 'No buckets on this account.'
                  : 'No buckets in this state.'}
              </Text>
            }
          />
        </Flex>
      </Container>
    </>
  );
};
