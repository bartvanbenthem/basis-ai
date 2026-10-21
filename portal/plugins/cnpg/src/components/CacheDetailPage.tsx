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
  CACHE_MODES,
  cacheMaxMemory,
  cachePods,
  type ClusterEvent,
  cnpgCacheCredentialsReadPermission,
  cnpgCacheDeletePermission,
  cnpgCacheUpdatePermission,
  type Condition,
  type InstancePod,
  type ValkeyCacheDetails,
} from '@internal/backstage-plugin-cnpg-common';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useAsync from 'react-use/esm/useAsync';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { cnpgApiRef } from '../api';
import { cacheMonitoringRouteRef, cacheRouteRef, cachesRouteRef, editCacheRouteRef, projectRouteRef } from '../routes';
import { ConnectionUri, StaticTable } from './ClusterDetails';
import { age, CacheHealthBadge, cacheHealth, ErrorAlert, Fields, Mono, Panel } from './common';
import { GrafanaDashboard } from './GrafanaDashboard';

const DeleteDialog = ({
  namespace,
  name,
  isOpen,
  onOpenChange,
}: {
  namespace: string;
  name: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const api = useApi(cnpgApiRef);
  const navigate = useNavigate();
  const listLink = useRouteRef(cachesRouteRef);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<Error>();
  const [pending, setPending] = useState(false);

  const onDelete = async () => {
    setPending(true);
    try {
      await api.deleteCache(namespace, name);
      onOpenChange(false);
      navigate(listLink?.() ?? '/cnpg/caches');
    } catch (e) {
      setError(e as Error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={520}>
      <DialogHeader>Delete {namespace}/{name}?</DialogHeader>
      <DialogBody>
        <Flex direction="column" gap="3">
          <Text>
            This deletes the Valkey cluster, its pods, its password Secret and every key in it. Clients
            using it fall back to their source on the next request.
          </Text>
          <TextField label={`Type "${name}" to confirm`} value={confirm} onChange={setConfirm} />
          {error && <ErrorAlert error={error} />}
        </Flex>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onPress={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" destructive isDisabled={confirm !== name} loading={pending} onPress={onDelete}>
          Delete
        </Button>
      </DialogFooter>
    </Dialog>
  );
};

export const CacheDetails = ({ details }: { details: ValkeyCacheDetails }) => {
  const api = useApi(cnpgApiRef);
  const projectLink = useRouteRef(projectRouteRef);
  const { allowed: canReadCredentials } = usePermission({ permission: cnpgCacheCredentialsReadPermission });
  const { summary, resource, pods, events, unreachable } = details;
  const status = resource.status ?? {};
  const h = cacheHealth(summary);
  const [host, port] = (summary.endpoint ?? '').split(':');
  const plainClient = summary.shards === 1 && summary.replicas === 0;

  const podRows = pods.map(p => ({ ...p, id: p.name }));
  const conditionRows = (status.conditions ?? []).map(c => ({ ...c, id: c.type }));
  const eventRows = events.map((e, i) => ({ ...e, id: `${i}` }));

  return (
    <Flex direction="column" gap="4">
      {h !== 'healthy' && (
        <Alert
          status={h === 'degraded' || summary.message?.startsWith("Can't") ? 'warning' : 'info'}
          title={h === 'deleting' ? 'Deleting' : summary.state}
          description={summary.message}
        />
      )}
      {unreachable && (
        <Alert
          status="warning"
          title={`Can't read location ${summary.location}`}
          description={`Its pods and events are missing below: ${unreachable}`}
        />
      )}

      <Grid.Root columns={{ initial: '1', md: '2' }} gap="4">
        <Panel title="Overview">
          <Fields
            rows={[
              ['Mode', `${CACHE_MODES[summary.mode].displayName}${status.modules?.length ? ` (modules: ${status.modules.join(', ')})` : ''}`],
              ['State', summary.state],
              ['Shards ready', `${summary.readyShards} / ${summary.shards}`],
              ['Pods', `${cachePods(summary)} (${summary.replicas} replica${summary.replicas === 1 ? '' : 's'} per shard)`],
              ['Location', summary.location || 'not placed yet'],
              [
                'Project',
                summary.project ? (
                  <Link href={projectLink?.({ name: summary.project })}>{summary.project}</Link>
                ) : (
                  summary.namespace
                ),
              ],
              ['Owner', summary.owner ?? '-'],
              ['Created', summary.createdAt ? `${new Date(summary.createdAt).toLocaleString()} (${age(summary.createdAt)} ago)` : '-'],
            ]}
          />
        </Panel>

        <Panel title="Connect">
          <Fields
            rows={[
              ['Endpoint', summary.endpoint ? <Mono>{summary.endpoint}</Mono> : '-'],
              ['In location', summary.location || '-'],
              ['Credentials', <Mono>Secret {summary.namespace}/{summary.secret ?? `${summary.name}-valkey`}-auth</Mono>],
              ['On the control plane', <Mono>Secret {summary.namespace}/{summary.secret ?? `${summary.name}-valkey`}</Mono>],
              [
                'Connection URI',
                canReadCredentials ? (
                  <ConnectionUri
                    load={() => api.getCacheConnection(summary.namespace, summary.name)}
                    masked={`valkey://default:••••••@${host || `valkey-${summary.name}.${summary.namespace}.svc`}:${port || 6379}`}
                  />
                ) : (
                  'needs the cnpg.cache.credentials.read permission'
                ),
              ],
              [
                'Clients',
                plainClient
                  ? 'One node: any client works, also without cluster support (e.g. LiteLLM valkey-semantic).'
                  : 'Cluster mode: use a cluster-aware client (valkey-glide, redis-py RedisCluster, redisvl).',
              ],
            ]}
          />
        </Panel>

        <Panel title="Memory & eviction">
          <Fields
            rows={[
              ['CPU / memory per pod', `${summary.cpu} / ${summary.memory}`],
              ['maxmemory', `${cacheMaxMemory(summary.memory, summary.maxMemoryPercent) ?? '-'} (${summary.maxMemoryPercent}%)`],
              ['Eviction policy', <Mono>{summary.evictionPolicy}</Mono>],
              ['Persistence', 'none (memory only)'],
              ['Metrics (PodMonitor)', summary.monitoring ? 'enabled' : 'disabled'],
              ['Alerts (PrometheusRule)', summary.alerts ? 'enabled' : 'disabled'],
              ['Grafana dashboard', summary.dashboardUid ? <Mono>{summary.dashboardUid}</Mono> : 'disabled'],
            ]}
          />
        </Panel>

        <Panel title="Cache keys">
          <Text variant="body-small" color="secondary">
            Put the tenant, user or role scope, the model ID and the system-prompt version in every key (or as
            a TAG filter in the KNN query): the cache answers before guardrails and context construction run.
            Start semantic thresholds strict (about 0.9) and measure hits against wrong answers; shorten TTLs or
            purge by tag when source data changes.
          </Text>
        </Panel>
      </Grid.Root>

      <Panel title="Pods">
        <StaticTable<InstancePod & { id: string }>
          rows={podRows}
          empty="No pods yet."
          columns={[
            { id: 'name', label: 'Pod', isRowHeader: true, cell: p => <CellText title={p.name} /> },
            { id: 'role', label: 'Position', cell: p => <CellText title={p.role} /> },
            { id: 'phase', label: 'Phase', cell: p => <CellText title={p.phase} /> },
            { id: 'ready', label: 'Ready', cell: p => <CellText title={p.ready ? 'yes' : 'no'} /> },
            { id: 'node', label: 'Node', cell: p => <CellText title={p.node ?? '-'} /> },
            { id: 'restarts', label: 'Restarts', cell: p => <CellText title={String(p.restarts)} /> },
            { id: 'age', label: 'Age', cell: p => <CellText title={age(p.createdAt)} /> },
          ]}
        />
      </Panel>

      <Panel title="Conditions">
        <StaticTable<Condition & { id: string }>
          rows={conditionRows}
          empty="No conditions reported yet."
          columns={[
            { id: 'type', label: 'Type', isRowHeader: true, cell: c => <CellText title={c.type} /> },
            { id: 'status', label: 'Status', cell: c => <CellText title={c.status} /> },
            { id: 'reason', label: 'Reason', cell: c => <CellText title={c.reason ?? ''} /> },
            { id: 'message', label: 'Message', cell: c => <CellText title={c.message ?? ''} /> },
          ]}
        />
      </Panel>

      <Panel title="Recent events">
        <StaticTable<ClusterEvent & { id: string }>
          rows={eventRows}
          empty="No recent events."
          columns={[
            { id: 'type', label: 'Type', cell: e => <CellText title={e.type} /> },
            { id: 'reason', label: 'Reason', isRowHeader: true, cell: e => <CellText title={e.reason} /> },
            { id: 'object', label: 'Object', cell: e => <CellText title={e.object} /> },
            { id: 'message', label: 'Message', cell: e => <CellText title={e.message} /> },
            { id: 'last', label: 'Last seen', cell: e => <CellText title={`${age(e.lastSeen)} ago${e.count > 1 ? ` (×${e.count})` : ''}`} /> },
          ]}
        />
      </Panel>
    </Flex>
  );
};

/** Loads (and keeps polling) one cache; used by the page and the entity tab. */
export function useCacheDetails(namespace: string, name: string) {
  const api = useApi(cnpgApiRef);
  const state = useAsyncRetry(() => api.getCache(namespace, name), [api, namespace, name]);
  useInterval(state.retry, 10_000);
  return state;
}

/** One ValkeyCache: health, how to connect, its settings, pods, conditions and events; and its dashboard. */
export const CacheDetailPage = ({ tab }: { tab: 'overview' | 'monitoring' }) => {
  const { namespace = '', name = '' } = useParams();
  const api = useApi(cnpgApiRef);
  const overviewLink = useRouteRef(cacheRouteRef);
  const monitoringLink = useRouteRef(cacheMonitoringRouteRef);
  const editLink = useRouteRef(editCacheRouteRef);
  const { allowed: canDelete } = usePermission({ permission: cnpgCacheDeletePermission });
  const { allowed: canUpdate } = usePermission({ permission: cnpgCacheUpdatePermission });
  const [deleting, setDeleting] = useState(false);
  const { value: config } = useAsync(() => api.getConfig(), [api]);
  const { value, error } = useCacheDetails(namespace, name);
  const params = { namespace, name };
  const tabs =
    overviewLink && monitoringLink
      ? [
          { id: 'overview', label: 'Overview', href: overviewLink(params) },
          { id: 'monitoring', label: 'Monitoring', href: monitoringLink(params) },
        ]
      : undefined;

  return (
    <>
      <Header
        title={name}
        tags={[{ label: `project: ${namespace}` }, { label: 'valkey' }]}
        tabs={tabs}
        activeTabId={tab}
        customActions={
          <Flex gap="3" align="center">
            {value && <CacheHealthBadge cache={value.summary} />}
            {canUpdate && editLink && value && !value.summary.deleting && (
              <ButtonLink href={editLink({ namespace, name })} variant="secondary">
                Edit
              </ButtonLink>
            )}
            {canDelete && (
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
        {value && tab === 'overview' && <CacheDetails details={value} />}
        {value && tab === 'monitoring' && (
          <GrafanaDashboard
            grafanaUrl={value.summary.grafanaUrl ?? config?.grafanaUrl}
            namespace={namespace}
            name={name}
            uid={value.summary.dashboardUid}
            title="Valkey"
            subject="cache"
          />
        )}
      </Container>
      <DeleteDialog namespace={namespace} name={name} isOpen={deleting} onOpenChange={setDeleting} />
    </>
  );
};
