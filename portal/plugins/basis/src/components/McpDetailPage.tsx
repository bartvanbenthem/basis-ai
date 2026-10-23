import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  Alert,
  Button,
  ButtonLink,
  CellText,
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
  Text,
  TextField,
} from '@backstage/ui';
import {
  basisMcpCredentialsReadPermission,
  basisMcpDeletePermission,
  basisMcpUpdatePermission,
  claudeMcpAddCommand,
  clientTools,
  type ClusterEvent,
  type InstancePod,
  type MCPServerDetails,
  type MCPServerSummary,
  type McpKey,
  type McpSiteStatus,
} from '@internal/backstage-plugin-basis-common';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { basisApiRef } from '../api';
import { clusterRouteRef, editMcpServerRouteRef, mcpServersRouteRef, projectRouteRef, stackRouteRef } from '../routes';
import { StaticTable } from './ClusterDetails';
import { age, ErrorAlert, Fields, Mono, Panel, McpHealthBadge, mcpHealth } from './common';
import { servesLabel } from './McpListPage';

const ALERT_TITLE: Record<string, string> = {
  deleting: 'Deleting',
  degraded: 'Waiting for something else',
  progressing: 'Starting',
};

/** A site serves (every tool), is the read-only standby, or isn't ready. */
function siteState(s: McpSiteStatus): string {
  if (!s.ready) return 'not ready';
  if (s.replicas === 0) return 'stopped';
  return s.active ? 'active' : 'standby (search, fetch, recall)';
}

const DeleteDialog = ({
  summary,
  isOpen,
  onOpenChange,
}: {
  summary: MCPServerSummary;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const api = useApi(basisApiRef);
  const navigate = useNavigate();
  const listLink = useRouteRef(mcpServersRouteRef);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<Error>();
  const [pending, setPending] = useState(false);
  const onDelete = async () => {
    setPending(true);
    try {
      await api.deleteMcpServer(summary.namespace, summary.name);
      onOpenChange(false);
      navigate(listLink?.() ?? '/basis/mcp-servers');
    } catch (e) {
      setError(e as Error);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={560}>
      <DialogHeader>Delete MCP server {summary.namespace}/{summary.name}?</DialogHeader>
      <DialogBody>
        <Flex direction="column" gap="3">
          <Text>
            The server goes from every site and its clients' keys stop working. The documents and memories stay in{' '}
            {summary.databaseKind === 'GenAIStack' ? 'stack' : 'cluster'} {summary.database}'s database (schema mcp): a new
            server over it finds them again.
          </Text>
          <TextField label={`Type "${summary.name}" to confirm`} value={confirm} onChange={setConfirm} />
          {error && <ErrorAlert error={error} />}
        </Flex>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onPress={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" destructive isDisabled={confirm !== summary.name} loading={pending} onPress={onDelete}>
          Delete
        </Button>
      </DialogFooter>
    </Dialog>
  );
};

/** How agents connect and, with basis.mcp.credentials.read, the clients' keys. */
const ConnectPanel = ({ summary }: { summary: MCPServerSummary }) => {
  const api = useApi(basisApiRef);
  const { allowed } = usePermission({ permission: basisMcpCredentialsReadPermission });
  const [keys, setKeys] = useState<McpKey[]>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const active = summary.clients.filter(c => !summary.expiredClients.includes(c.name));
  const [first] = active;

  const toggle = async () => {
    if (keys) {
      setKeys(undefined);
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      setKeys(await api.getMcpKeys(summary.namespace, summary.name));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <Panel title="Connect an agent">
      <Flex direction="column" gap="3">
        <Text variant="body-small" color="secondary">
          In the project's location, any MCP client over streamable HTTP: <Mono>{summary.endpoint}</Mono> with{' '}
          <Mono>Authorization: Bearer &lt;key&gt;</Mono>, the client's key from Secret{' '}
          <Mono>
            {summary.namespace}/{summary.keysSecret}
          </Mono>
          .
        </Text>
        {first && (
          <>
            <Text variant="body-small" color="secondary">
              Claude Code on your machine, through a port-forward:
            </Text>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>
              {claudeMcpAddCommand(summary, first.name).join('\n')}
            </pre>
          </>
        )}
        <Fields
          rows={active.map(c => [
            c.name,
            keys ? <Mono key={c.name}>{keys.find(k => k.client === c.name)?.key ?? 'not generated yet'}</Mono> : '••••••',
          ])}
        />
        {allowed && active.length > 0 && (
          <Flex>
            <Button size="small" variant="secondary" loading={pending} onPress={toggle}>
              {keys ? 'Hide keys' : 'Show keys'}
            </Button>
          </Flex>
        )}
        {error && (
          <Text variant="body-small" color="danger">
            {error}
          </Text>
        )}
      </Flex>
    </Panel>
  );
};

export const McpDetails = ({ details }: { details: MCPServerDetails }) => {
  const { summary, pods, events, unreachable } = details;
  const projectLink = useRouteRef(projectRouteRef);
  const stackLink = useRouteRef(stackRouteRef);
  const clusterLink = useRouteRef(clusterRouteRef);
  const h = mcpHealth(summary);
  const ns = summary.namespace;
  const sites = summary.sites.map(s => ({ ...s, id: s.site }));
  const podRows = pods.map(p => ({ ...p, id: `${p.location}/${p.name}` }));
  const eventRows = events.map((e, i) => ({ ...e, id: `${i}` }));
  const clientRows = summary.clients.map(c => ({ ...c, id: c.name }));
  const databaseHref =
    summary.databaseKind === 'GenAIStack'
      ? stackLink?.({ namespace: ns, name: summary.database })
      : clusterLink?.({ namespace: ns, name: summary.database });
  const table = summary.table ?? 'mcp.documents (the server\'s own)';

  return (
    <Flex direction="column" gap="4">
      {h !== 'healthy' && (
        <Alert
          status={h === 'degraded' ? 'warning' : 'info'}
          title={ALERT_TITLE[h] ?? 'Starting'}
          description={summary.message}
        />
      )}
      {unreachable && (
        <Alert status="warning" title="A location can't be reached" description={`Its pods and events are missing below: ${unreachable}`} />
      )}
      <Grid.Root columns={{ initial: '1', md: '2' }} gap="4">
        <Panel title="Overview">
          <Fields
            rows={[
              ['Project', summary.project ? <Link href={projectLink?.({ name: summary.project })}>{summary.project}</Link> : ns],
              [
                'Database',
                <Link key="db" href={databaseHref}>
                  {summary.databaseKind === 'GenAIStack' ? 'stack' : 'cluster'} {summary.database}
                </Link>,
              ],
              ['Serves', servesLabel(summary)],
              ['Tools', <Mono key="tools">{summary.tools.join(', ') || '-'}</Mono>],
              [
                'Search',
                summary.retrieval
                  ? `${summary.mode} over ${table}${summary.embeddingsModel ? `, embeddings ${summary.embeddingsModel}` : ''}`
                  : 'off',
              ],
              [
                'Memory',
                summary.memory
                  ? `${summary.memoryScope === 'shared' ? 'shared by every client' : 'each client its own'}${
                      summary.retentionDays ? `, kept ${summary.retentionDays} days` : ''
                    }`
                  : 'off',
              ],
              ['Owner', summary.owner ?? '-'],
              ['Created', summary.createdAt ? `${new Date(summary.createdAt).toLocaleString()} (${age(summary.createdAt)} ago)` : '-'],
            ]}
          />
        </Panel>
        <ConnectPanel summary={summary} />
      </Grid.Root>

      <Panel title="Clients">
        <StaticTable<(typeof clientRows)[number]>
          rows={clientRows}
          empty="No clients: nobody can call it."
          columns={[
            { id: 'name', label: 'Client', isRowHeader: true, cell: c => <CellText title={c.name} description={c.owner} /> },
            { id: 'tools', label: 'Tools', cell: c => <CellText title={clientTools(summary.tools, c).join(', ') || 'none'} /> },
            {
              id: 'expires',
              label: 'Key',
              cell: c => (
                <CellText
                  title={summary.expiredClients.includes(c.name) ? 'expired, revoked' : 'active'}
                  description={c.expiresAt ? `last day ${c.expiresAt}` : undefined}
                />
              ),
            },
          ]}
        />
      </Panel>

      <Panel title="Sites">
        <StaticTable<McpSiteStatus & { id: string }>
          rows={sites}
          empty="No sites yet."
          columns={[
            { id: 'site', label: 'Site', isRowHeader: true, cell: s => <CellText title={s.site} /> },
            { id: 'location', label: 'Location', cell: s => <CellText title={s.location || '-'} /> },
            { id: 'replicas', label: 'Replicas', cell: s => <CellText title={s.replicas === undefined ? '-' : String(s.replicas)} /> },
            { id: 'state', label: 'State', cell: s => <CellText title={siteState(s)} /> },
          ]}
        />
      </Panel>

      <Panel title="Pods">
        <StaticTable<InstancePod & { id: string }>
          rows={podRows}
          empty="No pods yet."
          columns={[
            { id: 'name', label: 'Pod', isRowHeader: true, cell: p => <CellText title={p.name} description={p.location} /> },
            { id: 'role', label: 'Site', cell: p => <CellText title={p.role} /> },
            { id: 'phase', label: 'Phase', cell: p => <CellText title={p.phase} /> },
            { id: 'ready', label: 'Ready', cell: p => <CellText title={p.ready ? 'yes' : 'no (database or tables not ready)'} /> },
            { id: 'node', label: 'Node', cell: p => <CellText title={p.node ?? '-'} /> },
            { id: 'restarts', label: 'Restarts', cell: p => <CellText title={String(p.restarts)} /> },
            { id: 'age', label: 'Age', cell: p => <CellText title={age(p.createdAt)} /> },
          ]}
        />
      </Panel>

      <Panel title="Recent events">
        <StaticTable<ClusterEvent & { id: string }>
          rows={eventRows}
          empty="No recent events."
          columns={[
            { id: 'type', label: 'Type', cell: e => <CellText title={e.type} /> },
            { id: 'reason', label: 'Reason', isRowHeader: true, cell: e => <CellText title={e.reason} description={e.location} /> },
            { id: 'object', label: 'Object', cell: e => <CellText title={e.object} /> },
            { id: 'message', label: 'Message', cell: e => <CellText title={e.message} /> },
            { id: 'last', label: 'Last seen', cell: e => <CellText title={`${age(e.lastSeen)} ago${e.count > 1 ? ` (×${e.count})` : ''}`} /> },
          ]}
        />
      </Panel>
    </Flex>
  );
};

/** One MCPServer: what it serves over which database, how agents connect, its sites, pods and events. */
export const McpDetailPage = () => {
  const { namespace = '', name = '' } = useParams();
  const api = useApi(basisApiRef);
  const editLink = useRouteRef(editMcpServerRouteRef);
  const { allowed: canDelete } = usePermission({ permission: basisMcpDeletePermission });
  const { allowed: canUpdate } = usePermission({ permission: basisMcpUpdatePermission });
  const [deleting, setDeleting] = useState(false);
  const { value, error, retry } = useAsyncRetry(() => api.getMcpServer(namespace, name), [api, namespace, name]);
  useInterval(retry, 10_000);
  const summary = value?.summary;

  return (
    <>
      <Header
        title={name}
        tags={[{ label: `project: ${namespace}` }, { label: 'MCP server' }]}
        customActions={
          <Flex gap="3" align="center">
            {summary && <McpHealthBadge server={summary} />}
            {summary?.grafanaUrl && summary.dashboardUid && (
              <ButtonLink href={`${summary.grafanaUrl.replace(/\/$/, '')}/d/${summary.dashboardUid}`} target="_blank" variant="secondary">
                Dashboard
              </ButtonLink>
            )}
            {canUpdate && editLink && summary && !summary.deleting && (
              <ButtonLink href={editLink({ namespace, name })} variant="secondary">
                Edit
              </ButtonLink>
            )}
            {canDelete && summary && (
              <Button variant="secondary" destructive onPress={() => setDeleting(true)}>
                Delete
              </Button>
            )}
          </Flex>
        }
      />
      <Container>
        {error && !value && <ErrorAlert error={error} />}
        {!error && !value && <Skeleton width="100%" height={240} />}
        {value && <McpDetails details={value} />}
      </Container>
      {value && <DeleteDialog summary={value.summary} isOpen={deleting} onOpenChange={setDeleting} />}
    </>
  );
};
