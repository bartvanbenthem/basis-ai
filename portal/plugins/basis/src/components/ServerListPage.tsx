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
import { basisServerCreatePermission, type ModelServerSummary, serverGPUs } from '@internal/backstage-plugin-basis-common';
import { useMemo, useState } from 'react';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { basisApiRef } from '../api';
import { createServerRouteRef, serverRouteRef } from '../routes';
import { age, ErrorAlert, ServerHealthBadge, serverHealth } from './common';

type Row = ModelServerSummary & { id: string };

const ALL = '__all__';

/** Every ModelServer across the projects: the self-hosted models. */
export const ServerListPage = () => {
  const api = useApi(basisApiRef);
  const serverLink = useRouteRef(serverRouteRef);
  const createLink = useRouteRef(createServerRouteRef);
  const { allowed: canCreate } = usePermission({ permission: basisServerCreatePermission });
  const [namespace, setNamespace] = useState<string>(ALL);
  const [search, setSearch] = useState('');

  const { value, loading, error, retry } = useAsyncRetry(() => api.listServers(), [api]);
  useInterval(retry, 15_000);

  const namespaces = useMemo(() => Array.from(new Set((value ?? []).map(s => s.namespace))).sort(), [value]);
  const rows: Row[] = useMemo(
    () =>
      (value ?? [])
        .filter(s => namespace === ALL || s.namespace === namespace)
        .filter(s => !search || `${s.namespace}/${s.name} ${s.model}`.toLowerCase().includes(search.toLowerCase()))
        .map(s => ({ ...s, id: `${s.namespace}/${s.name}` })),
    [value, namespace, search],
  );

  const columns: ColumnConfig<Row>[] = [
    {
      id: 'name',
      label: 'Name',
      isRowHeader: true,
      cell: s => (
        <CellText
          title={s.name}
          description={`serves ${s.model}${s.owner ? `, owner: ${s.owner}` : ''}`}
          href={serverLink?.({ namespace: s.namespace, name: s.name })}
        />
      ),
    },
    { id: 'namespace', label: 'Project', cell: s => <CellText title={s.namespace} /> },
    {
      id: 'status',
      label: 'Status',
      cell: s => (
        <Cell>
          <ServerHealthBadge server={s} />
        </Cell>
      ),
    },
    { id: 'uri', label: 'Model', cell: s => <CellText title={s.uri} /> },
    {
      id: 'replicas',
      label: 'Replicas',
      cell: s => (
        <CellText
          title={s.recovery ? `${s.replicas} + ${s.recoveryReplicas}` : String(s.replicas)}
          description={s.recovery ? 'protected + recovery' : undefined}
        />
      ),
    },
    {
      id: 'gpus',
      label: 'GPUs',
      cell: s => <CellText title={s.gpus ? `${s.gpus} per replica` : 'CPU only'} description={s.gpus ? `${serverGPUs(s)} in all` : undefined} />,
    },
    { id: 'routing', label: 'Routing', cell: s => <CellText title={s.prefixCacheAware ? 'prefix-cache-aware' : 'round robin'} /> },
    { id: 'age', label: 'Age', cell: s => <CellText title={age(s.createdAt)} /> },
  ];

  const stats = useMemo(() => {
    const all = value ?? [];
    return [
      { label: 'Servers', value: all.length, hint: `${namespaces.length} project${namespaces.length === 1 ? '' : 's'}` },
      { label: 'Healthy', value: all.filter(s => serverHealth(s) === 'healthy').length, hint: 'vLLM serving in every site' },
      { label: 'Replicas', value: all.reduce((n, s) => n + s.replicas + (s.recovery ? s.recoveryReplicas : 0), 0), hint: 'across all sites' },
      { label: 'GPUs', value: all.reduce((n, s) => n + serverGPUs(s), 0), hint: 'held while running' },
    ];
  }, [value, namespaces]);

  const { tableProps } = useTable({ mode: 'complete', data: rows, paginationOptions: { pageSize: 20 } });

  return (
    <>
      <Header
        title="Model servers"
        description="Self-hosted models on the projects' GPUs: vLLM on KServe with llm-d's prefix-cache-aware routing, provisioned through the ModelServer API"
        customActions={
          canCreate && createLink ? (
            <ButtonLink href={createLink()} variant="primary">
              Create server
            </ButtonLink>
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
            <SearchField label="Search" placeholder="project/name or model" value={search} onChange={setSearch} />
          </Flex>
          <Table
            columnConfig={columns}
            {...tableProps}
            loading={loading && !value}
            emptyState={<Text color="secondary">No ModelServers found{namespace !== ALL ? ` in ${namespace}` : ''}.</Text>}
          />
        </Flex>
      </Container>
    </>
  );
};
