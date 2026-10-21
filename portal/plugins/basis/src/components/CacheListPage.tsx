import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  ButtonLink,
  Cell,
  CellText,
  type ColumnConfig,
  Container,
  Flex,
  Header,
  SearchField,
  Select,
  Table,
  Text,
  useTable,
} from '@backstage/ui';
import {
  CACHE_MODES,
  cacheMaxMemory,
  cachePods,
  basisCacheCreatePermission,
  type ValkeyCacheSummary,
} from '@internal/backstage-plugin-basis-common';
import { useMemo, useState } from 'react';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { basisApiRef } from '../api';
import { cacheRouteRef, createCacheRouteRef } from '../routes';
import { age, CacheHealthBadge, cacheHealth, ErrorAlert } from './common';

type Row = ValkeyCacheSummary & { id: string };

const ALL = '__all__';

/** Every ValkeyCache, exact and semantic, across the projects. */
export const CacheListPage = () => {
  const api = useApi(basisApiRef);
  const cacheLink = useRouteRef(cacheRouteRef);
  const createLink = useRouteRef(createCacheRouteRef);
  const { allowed: canCreate } = usePermission({ permission: basisCacheCreatePermission });
  const [namespace, setNamespace] = useState<string>(ALL);
  const [search, setSearch] = useState('');

  const { value, loading, error, retry } = useAsyncRetry(() => api.listCaches(), [api]);
  useInterval(retry, 15_000);

  const namespaces = useMemo(
    () => Array.from(new Set((value ?? []).map(c => c.namespace))).sort(),
    [value],
  );
  const rows: Row[] = useMemo(
    () =>
      (value ?? [])
        .filter(c => namespace === ALL || c.namespace === namespace)
        .filter(c => !search || `${c.namespace}/${c.name}`.includes(search.toLowerCase()))
        .map(c => ({ ...c, id: `${c.namespace}/${c.name}` })),
    [value, namespace, search],
  );

  const columns: ColumnConfig<Row>[] = [
    {
      id: 'name',
      label: 'Name',
      isRowHeader: true,
      cell: c => (
        <CellText
          title={c.name}
          description={c.owner ? `owner: ${c.owner}` : undefined}
          href={cacheLink?.({ namespace: c.namespace, name: c.name })}
        />
      ),
    },
    { id: 'namespace', label: 'Project', cell: c => <CellText title={c.namespace} /> },
    {
      id: 'status',
      label: 'Status',
      cell: c => (
        <Cell>
          <CacheHealthBadge cache={c} />
        </Cell>
      ),
    },
    { id: 'mode', label: 'Mode', cell: c => <CellText title={CACHE_MODES[c.mode].displayName} /> },
    {
      id: 'shards',
      label: 'Shards',
      cell: c => (
        <CellText
          title={`${c.readyShards}/${c.shards}`}
          description={`${c.replicas} replica${c.replicas === 1 ? '' : 's'} each, ${cachePods(c)} pods`}
        />
      ),
    },
    {
      id: 'memory',
      label: 'Memory',
      cell: c => <CellText title={c.memory} description={`maxmemory ${cacheMaxMemory(c.memory, c.maxMemoryPercent) ?? '-'}, ${c.evictionPolicy}`} />,
    },
    {
      id: 'location',
      label: 'Location',
      cell: c => <CellText title={c.location || '-'} description={`${c.site} site`} />,
    },
    { id: 'age', label: 'Age', cell: c => <CellText title={age(c.createdAt)} /> },
  ];

  const stats = useMemo(() => {
    const all = value ?? [];
    const count = (h: string) => all.filter(c => cacheHealth(c) === h).length;
    return [
      { label: 'Caches', value: all.length, hint: `${namespaces.length} project${namespaces.length === 1 ? '' : 's'}` },
      { label: 'Healthy', value: count('healthy'), hint: 'Ready in Crossplane and the operator' },
      {
        label: 'Needs attention',
        value: count('degraded') + count('progressing'),
        hint: `${count('degraded')} degraded, ${count('progressing')} provisioning`,
      },
      {
        label: 'Semantic',
        value: all.filter(c => c.mode === 'semantic').length,
        hint: 'with valkey-search',
      },
      {
        label: 'Pods',
        value: all.reduce((n, c) => n + cachePods(c), 0),
        hint: 'Valkey nodes across all shards',
      },
    ];
  }, [value, namespaces]);

  const { tableProps } = useTable({ mode: 'complete', data: rows, paginationOptions: { pageSize: 20 } });

  return (
    <>
      <Header
        title="Valkey caches"
        description="Exact and semantic caches provisioned through the ValkeyCache API"
        customActions={
          canCreate && createLink ? (
            <Flex gap="2">
              {/* The create form with the semantic mode (valkey-search) preset. */}
              <ButtonLink href={`${createLink()}?mode=semantic`} variant="secondary">
                Create semantic cache
              </ButtonLink>
              <ButtonLink href={createLink()} variant="primary">
                Create cache
              </ButtonLink>
            </Flex>
          ) : undefined
        }
      />
      <Container>
        <Flex direction="column" gap="4">
          {error && <ErrorAlert error={error} />}
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
              label="Project"
              value={namespace}
              onChange={key => setNamespace(String(key ?? ALL))}
              options={[{ id: ALL, label: 'All projects' }, ...namespaces.map(n => ({ id: n, label: n }))]}
            />
            <SearchField label="Search" placeholder="project/name" value={search} onChange={setSearch} />
          </Flex>
          <Table
            columnConfig={columns}
            {...tableProps}
            loading={loading && !value}
            emptyState={
              <Text color="secondary">
                No ValkeyCaches found{namespace !== ALL ? ` in ${namespace}` : ''}.
              </Text>
            }
          />
        </Flex>
      </Container>
    </>
  );
};
