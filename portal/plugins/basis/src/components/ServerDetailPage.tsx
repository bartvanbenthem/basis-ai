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
  basisServerDeletePermission,
  basisServerUpdatePermission,
  type ClusterEvent,
  type InstancePod,
  type ModelServerDetails,
  type ModelServerSummary,
  serverGPUs,
  type ServerSiteStatus,
} from '@internal/backstage-plugin-basis-common';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { basisApiRef } from '../api';
import { editServerRouteRef, gatewayRouteRef, projectRouteRef, serversRouteRef, stackRouteRef } from '../routes';
import { StaticTable } from './ClusterDetails';
import { age, ErrorAlert, Fields, Mono, Panel, ServerHealthBadge, serverHealth } from './common';

/** A site serves, is stopped (no replicas) or waits for KServe. */
function siteState(s: ServerSiteStatus): string {
  if (!s.ready) return 'not ready';
  return s.replicas === 0 ? 'stopped' : 'serving';
}

const DeleteDialog = ({
  summary,
  usedBy,
  isOpen,
  onOpenChange,
}: {
  summary: ModelServerSummary;
  usedBy: string[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const api = useApi(basisApiRef);
  const navigate = useNavigate();
  const listLink = useRouteRef(serversRouteRef);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<Error>();
  const [pending, setPending] = useState(false);
  const onDelete = async () => {
    setPending(true);
    try {
      await api.deleteServer(summary.namespace, summary.name);
      onOpenChange(false);
      navigate(listLink?.() ?? '/basis/servers');
    } catch (e) {
      setError(e as Error);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={560}>
      <DialogHeader>Delete model server {summary.namespace}/{summary.name}?</DialogHeader>
      <DialogBody>
        <Flex direction="column" gap="3">
          <Text>
            vLLM goes from every site and its GPUs are freed. The weights' source ({summary.uri}) and the token Secret stay.
          </Text>
          {usedBy.length > 0 && (
            <Alert
              status="warning"
              title={`Used by gateway(s) ${usedBy.join(', ')}`}
              description="Remove its models there first."
            />
          )}
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

export const ServerDetails = ({ details }: { details: ModelServerDetails }) => {
  const { summary, pods, events, gateways, unreachable } = details;
  const projectLink = useRouteRef(projectRouteRef);
  const gatewayLink = useRouteRef(gatewayRouteRef);
  const h = serverHealth(summary);
  const ns = summary.namespace;
  const sites = summary.sites.map(s => ({ ...s, id: s.site }));
  const podRows = pods.map(p => ({ ...p, id: `${p.location}/${p.name}` }));
  const eventRows = events.map((e, i) => ({ ...e, id: `${i}` }));

  return (
    <Flex direction="column" gap="4">
      {h !== 'healthy' && (
        <Alert
          status={h === 'degraded' ? 'warning' : 'info'}
          title={summary.deleting ? 'Deleting' : 'Loading the model'}
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
              ['Serves', <Mono key="model">{summary.model}</Mono>],
              ['Weights', <Mono key="uri">{summary.uri}</Mono>],
              [
                'Per replica',
                `${summary.gpus ? `${summary.gpus} × ${summary.gpuResource}` : 'no GPU'}, ${summary.cpu} CPU, ${summary.memory}${summary.image ? `, image ${summary.image}` : ''}`,
              ],
              ['GPUs in all', String(serverGPUs(summary))],
              ['Routing', summary.prefixCacheAware ? `prefix-cache-aware (InferencePool ${summary.inferencePool})` : 'round robin'],
              ['Owner', summary.owner ?? '-'],
              ['Created', summary.createdAt ? `${new Date(summary.createdAt).toLocaleString()} (${age(summary.createdAt)} ago)` : '-'],
            ]}
          />
        </Panel>
        <Panel title="Use it">
          <Flex direction="column" gap="2">
            <Text variant="body-small" color="secondary">
              Through a gateway: a model <Mono>{`{name: ${summary.model}, server: ${summary.name}}`}</Mono> in a model gateway or
              a stack's gateway of project {ns}, then <Mono>model: {summary.model}</Mono> with the gateway's key.
            </Text>
            <Text variant="body-small" color="secondary">
              Directly, in the project's location (no key, round robin): <Mono>OPENAI_BASE_URL={summary.endpoint}</Mono>
            </Text>
            {gateways.length === 0 && (
              <Text variant="body-small" color="secondary">
                No gateway routes to it yet.
              </Text>
            )}
            {gateways.map(g => (
              <Link key={g} href={gatewayLink?.({ namespace: ns, name: g })}>
                Gateway {g}
              </Link>
            ))}
          </Flex>
        </Panel>
      </Grid.Root>

      <Panel title="Sites">
        <StaticTable<ServerSiteStatus & { id: string }>
          rows={sites}
          empty="No sites yet."
          columns={[
            { id: 'site', label: 'Site', isRowHeader: true, cell: s => <CellText title={s.site} /> },
            { id: 'location', label: 'Location', cell: s => <CellText title={s.location || '-'} /> },
            { id: 'replicas', label: 'Replicas', cell: s => <CellText title={s.replicas === undefined ? '-' : String(s.replicas)} /> },
            { id: 'state', label: 'State', cell: s => <CellText title={siteState(s)} description={s.message} /> },
          ]}
        />
      </Panel>

      <Panel title="Pods">
        <StaticTable<InstancePod & { id: string }>
          rows={podRows}
          empty="No pods yet."
          columns={[
            { id: 'name', label: 'Pod', isRowHeader: true, cell: p => <CellText title={p.name} description={p.location} /> },
            { id: 'role', label: 'Role', cell: p => <CellText title={p.role} /> },
            { id: 'phase', label: 'Phase', cell: p => <CellText title={p.phase} /> },
            { id: 'ready', label: 'Ready', cell: p => <CellText title={p.ready ? 'yes' : 'no'} /> },
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

/** One ModelServer: what it serves, its sites, pods and events, and who routes to it. */
export const ServerDetailPage = () => {
  const { namespace = '', name = '' } = useParams();
  const api = useApi(basisApiRef);
  const editLink = useRouteRef(editServerRouteRef);
  const stackLink = useRouteRef(stackRouteRef);
  const { allowed: canDelete } = usePermission({ permission: basisServerDeletePermission });
  const { allowed: canUpdate } = usePermission({ permission: basisServerUpdatePermission });
  const [deleting, setDeleting] = useState(false);
  const { value, error, retry } = useAsyncRetry(() => api.getServer(namespace, name), [api, namespace, name]);
  useInterval(retry, 10_000);
  const summary = value?.summary;
  const stack = summary?.stack;

  return (
    <>
      <Header
        title={name}
        tags={[{ label: `project: ${namespace}` }, { label: 'model server' }]}
        customActions={
          <Flex gap="3" align="center">
            {summary && <ServerHealthBadge server={summary} />}
            {summary?.grafanaUrl && summary.dashboardUid && (
              <ButtonLink href={`${summary.grafanaUrl.replace(/\/$/, '')}/d/${summary.dashboardUid}`} target="_blank" variant="secondary">
                Dashboard
              </ButtonLink>
            )}
            {stack && stackLink && (
              <ButtonLink href={stackLink({ namespace, name: stack })} variant="secondary">
                Part of stack {stack}
              </ButtonLink>
            )}
            {canUpdate && editLink && summary && !summary.deleting && !stack && (
              <ButtonLink href={editLink({ namespace, name })} variant="secondary">
                Edit
              </ButtonLink>
            )}
            {canDelete && summary && !stack && (
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
        {value && <ServerDetails details={value} />}
      </Container>
      {value && <DeleteDialog summary={value.summary} usedBy={value.gateways} isOpen={deleting} onOpenChange={setDeleting} />}
    </>
  );
};
