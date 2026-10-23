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
import { basisMcpCreatePermission, type MCPServerSummary } from '@internal/backstage-plugin-basis-common';
import { useMemo, useState } from 'react';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { basisApiRef } from '../api';
import { createMcpServerRouteRef, mcpServerRouteRef } from '../routes';
import { age, ErrorAlert, McpHealthBadge, mcpHealth } from './common';

type Row = MCPServerSummary & { id: string };

const ALL = '__all__';

/** What a server serves, in a few words. */
export function servesLabel(s: Pick<MCPServerSummary, 'retrieval' | 'ingest' | 'memory'>): string {
  const parts = [];
  if (s.retrieval) parts.push(s.ingest ? 'knowledge base (read, write)' : 'knowledge base');
  if (s.memory) parts.push('memory');
  return parts.join(' + ') || 'nothing';
}

/** Every MCPServer across the projects: retrieval and agent memory as MCP tools. */
export const McpListPage = () => {
  const api = useApi(basisApiRef);
  const serverLink = useRouteRef(mcpServerRouteRef);
  const createLink = useRouteRef(createMcpServerRouteRef);
  const { allowed: canCreate } = usePermission({ permission: basisMcpCreatePermission });
  const [namespace, setNamespace] = useState<string>(ALL);
  const [search, setSearch] = useState('');

  const { value, loading, error, retry } = useAsyncRetry(() => api.listMcpServers(), [api]);
  useInterval(retry, 15_000);

  const namespaces = useMemo(() => Array.from(new Set((value ?? []).map(s => s.namespace))).sort(), [value]);
  const rows: Row[] = useMemo(
    () =>
      (value ?? [])
        .filter(s => namespace === ALL || s.namespace === namespace)
        .filter(s => !search || `${s.namespace}/${s.name} ${s.database}`.toLowerCase().includes(search.toLowerCase()))
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
          description={`${servesLabel(s)}${s.owner ? `, owner: ${s.owner}` : ''}`}
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
          <McpHealthBadge server={s} />
        </Cell>
      ),
    },
    {
      id: 'database',
      label: 'Database',
      cell: s => <CellText title={s.database} description={s.databaseKind === 'GenAIStack' ? 'GenAI stack' : 'PostgreSQL cluster'} />,
    },
    {
      id: 'search',
      label: 'Search',
      cell: s => <CellText title={s.mode} description={s.embeddingsModel ?? 'no embeddings model'} />,
    },
    { id: 'tools', label: 'Tools', cell: s => <CellText title={String(s.tools.length)} description={s.tools.join(', ')} /> },
    {
      id: 'clients',
      label: 'Clients',
      cell: s => (
        <CellText
          title={String(s.clients.length - s.expiredClients.length)}
          description={s.expiredClients.length ? `${s.expiredClients.length} expired` : undefined}
        />
      ),
    },
    { id: 'age', label: 'Age', cell: s => <CellText title={age(s.createdAt)} /> },
  ];

  const stats = useMemo(() => {
    const all = value ?? [];
    return [
      { label: 'Servers', value: all.length, hint: `${namespaces.length} project${namespaces.length === 1 ? '' : 's'}` },
      { label: 'Healthy', value: all.filter(s => mcpHealth(s) === 'healthy').length, hint: 'answering in every site' },
      { label: 'Clients', value: all.reduce((n, s) => n + s.clients.length - s.expiredClients.length, 0), hint: 'agents with a key' },
      { label: 'With memory', value: all.filter(s => s.memory).length, hint: `${all.filter(s => s.memoryScope === 'shared').length} shared` },
    ];
  }, [value, namespaces]);

  const { tableProps } = useTable({ mode: 'complete', data: rows, paginationOptions: { pageSize: 20 } });

  return (
    <>
      <Header
        title="MCP servers"
        description="Retrieval over a project's database and the agents' memory as MCP tools, with a key per agent, provisioned through the MCPServer API"
        customActions={
          canCreate && createLink ? (
            <ButtonLink href={createLink()} variant="primary">
              Create MCP server
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
            <SearchField label="Search" placeholder="project/name or database" value={search} onChange={setSearch} />
          </Flex>
          <Table
            columnConfig={columns}
            {...tableProps}
            loading={loading && !value}
            emptyState={<Text color="secondary">No MCPServers found{namespace !== ALL ? ` in ${namespace}` : ''}.</Text>}
          />
        </Flex>
      </Container>
    </>
  );
};
