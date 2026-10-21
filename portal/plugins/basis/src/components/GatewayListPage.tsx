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
import { basisGatewayCreatePermission, type ModelGatewaySummary } from '@internal/backstage-plugin-basis-common';
import { useMemo, useState } from 'react';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { basisApiRef } from '../api';
import { createGatewayRouteRef, gatewayRouteRef } from '../routes';
import { age, ErrorAlert, GatewayHealthBadge, gatewayHealth } from './common';

type Row = ModelGatewaySummary & { id: string };

const ALL = '__all__';

/** Every ModelGateway across the projects: shared ones and the stacks' own. */
export const GatewayListPage = () => {
  const api = useApi(basisApiRef);
  const gatewayLink = useRouteRef(gatewayRouteRef);
  const createLink = useRouteRef(createGatewayRouteRef);
  const { allowed: canCreate } = usePermission({ permission: basisGatewayCreatePermission });
  const [namespace, setNamespace] = useState<string>(ALL);
  const [search, setSearch] = useState('');

  const { value, loading, error, retry } = useAsyncRetry(() => api.listGateways(), [api]);
  useInterval(retry, 15_000);

  const namespaces = useMemo(() => Array.from(new Set((value ?? []).map(g => g.namespace))).sort(), [value]);
  const rows: Row[] = useMemo(
    () =>
      (value ?? [])
        .filter(g => namespace === ALL || g.namespace === namespace)
        .filter(g => !search || `${g.namespace}/${g.name}`.includes(search.toLowerCase()))
        .map(g => ({ ...g, id: `${g.namespace}/${g.name}` })),
    [value, namespace, search],
  );

  const columns: ColumnConfig<Row>[] = [
    {
      id: 'name',
      label: 'Name',
      isRowHeader: true,
      cell: g => (
        <CellText
          title={g.name}
          description={g.stack ? `stack ${g.stack}'s own` : `shared${g.owner ? `, owner: ${g.owner}` : ''}`}
          href={gatewayLink?.({ namespace: g.namespace, name: g.name })}
        />
      ),
    },
    { id: 'namespace', label: 'Project', cell: g => <CellText title={g.namespace} /> },
    {
      id: 'status',
      label: 'Status',
      cell: g => (
        <Cell>
          <GatewayHealthBadge gateway={g} />
        </Cell>
      ),
    },
    {
      id: 'models',
      label: 'Models',
      cell: g => <CellText title={String(g.models.length)} description={g.models.slice(0, 3).join(', ') || undefined} />,
    },
    { id: 'clients', label: 'Clients', cell: g => <CellText title={String(g.clients.length)} description={g.clients.slice(0, 3).join(', ')} /> },
    {
      id: 'sites',
      label: 'Sites',
      cell: g => <CellText title={g.recovery ? 'protected + recovery' : 'protected'} description={`active: ${g.activeSite}`} />,
    },
    { id: 'age', label: 'Age', cell: g => <CellText title={age(g.createdAt)} /> },
  ];

  const stats = useMemo(() => {
    const all = value ?? [];
    return [
      { label: 'Gateways', value: all.length, hint: `${namespaces.length} project${namespaces.length === 1 ? '' : 's'}` },
      { label: 'Healthy', value: all.filter(g => gatewayHealth(g) === 'healthy').length, hint: 'Agent Router ready in every site' },
      { label: 'Shared', value: all.filter(g => !g.stack).length, hint: 'not a stack\'s own' },
      { label: 'Models', value: all.reduce((n, g) => n + g.models.length, 0), hint: 'routes across all gateways' },
      { label: 'Clients', value: all.reduce((n, g) => n + g.clients.length, 0), hint: 'each with a key of its own' },
    ];
  }, [value, namespaces]);

  const { tableProps } = useTable({ mode: 'complete', data: rows, paginationOptions: { pageSize: 20 } });

  return (
    <>
      <Header
        title="Model gateways"
        description="OpenAI-compatible endpoints to the projects' models, hosted and self-hosted, provisioned through the ModelGateway API"
        customActions={
          canCreate && createLink ? (
            <ButtonLink href={createLink()} variant="primary">
              Create gateway
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
            <SearchField label="Search" placeholder="project/name" value={search} onChange={setSearch} />
          </Flex>
          <Table
            columnConfig={columns}
            {...tableProps}
            loading={loading && !value}
            emptyState={<Text color="secondary">No ModelGateways found{namespace !== ALL ? ` in ${namespace}` : ''}.</Text>}
          />
        </Flex>
      </Container>
    </>
  );
};
