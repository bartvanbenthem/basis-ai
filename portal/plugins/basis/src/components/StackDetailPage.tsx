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
  allowedStackPromotions,
  basisClusterFailoverPermission,
  basisClusterSwitchoverPermission,
  basisStackCredentialsReadPermission,
  basisStackDeletePermission,
  basisStackUpdatePermission,
  type GenAIStack,
  type PromotionRequest,
  type GenAIStackSummary,
  type StackConnection,
  type StackModel,
  type StackSiteStatus,
} from '@internal/backstage-plugin-basis-common';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { basisApiRef } from '../api';
import { cacheRouteRef, clusterRouteRef, editStackRouteRef, gatewayRouteRef, projectRouteRef, stacksRouteRef } from '../routes';
import { StaticTable } from './ClusterDetails';
import { age, ErrorAlert, Fields, Mono, Panel, StackHealthBadge, stackHealth } from './common';

/** Keys whose values are secrets: masked until shown. */
const SECRET_KEYS = /PASSWORD|_KEY$|_URL$/;

const DeleteDialog = ({
  summary,
  isOpen,
  onOpenChange,
}: {
  summary: GenAIStackSummary;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const api = useApi(basisApiRef);
  const navigate = useNavigate();
  const listLink = useRouteRef(stacksRouteRef);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<Error>();
  const [pending, setPending] = useState(false);
  const onDelete = async () => {
    setPending(true);
    try {
      await api.deleteStack(summary.namespace, summary.name);
      onOpenChange(false);
      navigate(listLink?.() ?? '/basis/stacks');
    } catch (e) {
      setError(e as Error);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={560}>
      <DialogHeader>Delete stack {summary.namespace}/{summary.name}?</DialogHeader>
      <DialogBody>
        <Flex direction="column" gap="3">
          <Text>
            This deletes database <Mono>{summary.database}</Mono> with its data
            {summary.recovery ? ' and its replica' : ''}, the cache{summary.recovery ? 's' : ''}, the gateway and the
            connection Secrets, in every site. Backups in the project's bucket are kept.
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

const SwitchDialog = ({
  summary,
  request,
  onClose,
  onDone,
}: {
  summary: GenAIStackSummary;
  request: PromotionRequest;
  onClose: () => void;
  onDone: () => void;
}) => {
  const api = useApi(basisApiRef);
  const failover = request.mode === 'Failover';
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error>();
  const submit = async () => {
    setPending(true);
    setError(undefined);
    try {
      await api.promoteStack(summary.namespace, summary.name, request);
      onDone();
    } catch (e) {
      setError(e as Error);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog isOpen onOpenChange={open => !open && onClose()} width={560}>
      <DialogHeader>
        {failover ? 'Fail over' : 'Switch over'} {summary.name} to the {request.site} site?
      </DialogHeader>
      <DialogBody>
        <Flex direction="column" gap="3">
          <Text>
            {failover
              ? `Database ${summary.database} in the ${request.site} site is promoted right away, without waiting for the ${summary.activeSite} site; transactions it hadn't archived are lost. `
              : `Database ${summary.database}'s primary in the ${summary.activeSite} site is demoted first and the ${request.site} site takes over once it has replayed everything, so nothing is lost; writes stop for a minute or two. `}
            Then the {request.site} site's cache and gateway get the full size and its connection Secret says ACTIVE=true.
          </Text>
          {failover && <TextField label={`Type "${summary.name}" to confirm`} value={confirm} onChange={setConfirm} />}
          {error && <ErrorAlert error={error} />}
        </Flex>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          Cancel
        </Button>
        <Button variant="primary" destructive={failover} isDisabled={failover && confirm !== summary.name} loading={pending} onPress={submit}>
          {failover ? 'Fail over' : 'Switch over'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
};

/** Moving the stack between its sites: the database moves its primary, the rest follows. */
const SitePanel = ({ summary, resource, onChanged }: { summary: GenAIStackSummary; resource: GenAIStack; onChanged: () => void }) => {
  const { allowed: canSwitchover } = usePermission({ permission: basisClusterSwitchoverPermission });
  const { allowed: canFailover } = usePermission({ permission: basisClusterFailoverPermission });
  const [request, setRequest] = useState<PromotionRequest>();
  const all = allowedStackPromotions(resource);
  const actions = all.filter(a => (a.mode === 'Failover' ? canFailover : canSwitchover));
  const switchover = actions.find(a => a.mode === 'Switchover');
  const failover = actions.find(a => a.mode === 'Failover');
  const location = (site: string) => summary.sites.find(s => s.site === site)?.location ?? site;

  return (
    <Panel title="Active site">
      <Flex direction="column" gap="3">
        {summary.switching ? (
          <Alert
            status="info"
            title={`Switching to the ${summary.targetSite} site`}
            description={summary.message ?? `Waiting for database ${summary.database} to move its primary.`}
          />
        ) : (
          <Text variant="body-small">
            Serving from the <strong>{summary.activeSite}</strong> site ({location(summary.activeSite)}).
          </Text>
        )}
        {switchover && (
          <Flex justify="between" align="center" gap="4">
            <Text variant="body-small">
              <strong>Switchover</strong> to the {switchover.site} site ({location(switchover.site)}): planned, loses nothing.
            </Text>
            <Button variant="primary" onPress={() => setRequest(switchover)}>
              Switch over
            </Button>
          </Flex>
        )}
        {failover && (
          <Flex justify="between" align="center" gap="4">
            <Text variant="body-small">
              <strong>Failover</strong> to the {failover.site} site ({location(failover.site)}): for when the{' '}
              {summary.activeSite} site is down. Unarchived transactions are lost.
            </Text>
            <Button variant="secondary" destructive onPress={() => setRequest(failover)}>
              Fail over
            </Button>
          </Flex>
        )}
        {!switchover && !failover && all.length > 0 && (
          <Text variant="body-small" color="secondary">
            You may not move this stack between its sites.
          </Text>
        )}
      </Flex>
      {request && (
        <SwitchDialog
          summary={summary}
          request={request}
          onClose={() => setRequest(undefined)}
          onDone={() => {
            setRequest(undefined);
            onChanged();
          }}
        />
      )}
    </Panel>
  );
};

/** The active site's wiring: keys always, values once asked for. */
const ConnectionPanel = ({ summary }: { summary: GenAIStackSummary }) => {
  const api = useApi(basisApiRef);
  const { allowed } = usePermission({ permission: basisStackCredentialsReadPermission });
  const [conn, setConn] = useState<StackConnection>();
  const [shown, setShown] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const toggle = async () => {
    if (shown) {
      setShown(false);
      return;
    }
    if (!conn) {
      setPending(true);
      setError(undefined);
      try {
        setConn(await api.getStackConnection(summary.namespace, summary.name));
      } catch (e) {
        setError((e as Error).message);
        return;
      } finally {
        setPending(false);
      }
    }
    setShown(true);
  };

  const snippet = `envFrom:\n  - secretRef:\n      name: ${summary.connectionSecret}`;
  return (
    <Panel title="Wiring">
      <Flex direction="column" gap="3">
        <Text variant="body-small" color="secondary">
          Every site's location has Secret <Mono>{summary.namespace}/{summary.connectionSecret}</Mono> with the same
          keys (SITE and ACTIVE tell the sites apart). Mount it in the app:
        </Text>
        <pre style={{ margin: 0, fontSize: 12 }}>{snippet}</pre>
        {allowed && (
          <Flex direction="column" gap="2">
            <Flex>
              <Button size="small" variant="secondary" loading={pending} onPress={toggle}>
                {shown ? 'Hide values' : 'Show values (active site)'}
              </Button>
            </Flex>
            {shown && conn && (
              <Fields
                rows={Object.keys(conn.values)
                  .sort()
                  .map(k => [k, <Mono key={k}>{conn.values[k]}</Mono>])}
              />
            )}
            {!shown && conn && (
              <Fields
                rows={Object.keys(conn.values)
                  .sort()
                  .map(k => [k, SECRET_KEYS.test(k) ? '••••••' : conn.values[k]])}
              />
            )}
            {error && (
              <Text variant="body-small" color="danger">
                {error}
              </Text>
            )}
          </Flex>
        )}
        <Text variant="body-small" color="secondary">
          Cache keys: tenant + model + system-prompt version + corpus version + the prompt. Keep the corpus version in
          a table of the RAG database, bumped with each ingestion batch: old answers stop matching, and each site's
          cache stays consistent with its own database.
        </Text>
      </Flex>
    </Panel>
  );
};

export const StackDetails = ({
  summary,
  resource,
  onChanged,
}: {
  summary: GenAIStackSummary;
  resource: GenAIStack;
  onChanged?: () => void;
}) => {
  const clusterLink = useRouteRef(clusterRouteRef);
  const cacheLink = useRouteRef(cacheRouteRef);
  const gatewayLink = useRouteRef(gatewayRouteRef);
  const projectLink = useRouteRef(projectRouteRef);
  const h = stackHealth(summary);
  const ns = summary.namespace;
  const models = (resource.spec.gateway?.models ?? []).map(m => ({ ...m, id: m.name }));
  const sites = summary.sites.map(s => ({ ...s, id: s.site }));

  return (
    <Flex direction="column" gap="4">
      {h !== 'healthy' && (
        <Alert status={h === 'degraded' ? 'warning' : 'info'} title={summary.deleting ? 'Deleting' : 'Provisioning'} description={summary.message} />
      )}
      <Grid.Root columns={{ initial: '1', md: '2' }} gap="4">
        <Panel title="Overview">
          <Fields
            rows={[
              [
                'Project',
                summary.project ? <Link href={projectLink?.({ name: summary.project })}>{summary.project}</Link> : ns,
              ],
              ['Sites', summary.recovery ? `protected + recovery (warm standby); active: ${summary.activeSite}` : 'protected only'],
              ['Owner', summary.owner ?? '-'],
              ['Deletion protection', summary.deletionProtection ? 'on' : 'off'],
              ...(summary.gatewayExternalEndpoint || summary.databaseExternalService
                ? [[
                    'External access',
                    <Flex key="ext" direction="column" gap="1">
                      {summary.gatewayExternalEndpoint && <Mono>Gateway: {summary.gatewayExternalEndpoint}</Mono>}
                      {summary.databaseExternalService && (
                        <Mono>
                          Database: Service {ns}/{summary.databaseExternalService} (TLS)
                        </Mono>
                      )}
                    </Flex>,
                  ] as [string, React.ReactNode]]
                : [['External access', 'internal only']] as Array<[string, React.ReactNode]>),
              ['Created', summary.createdAt ? `${new Date(summary.createdAt).toLocaleString()} (${age(summary.createdAt)} ago)` : '-'],
            ]}
          />
        </Panel>
        <Panel title="Components">
          <Fields
            rows={[
              ['Retrieval', <Link key="db" href={clusterLink?.({ namespace: ns, name: summary.database })}>{summary.database}</Link>],
              [
                'Cache',
                summary.cacheName ? (
                  <Link href={cacheLink?.({ namespace: ns, name: summary.cacheName })}>{summary.cacheName}</Link>
                ) : (
                  'off'
                ),
              ],
              ...(summary.recoveryCacheName
                ? [[
                    'Standby cache',
                    <Link key="dr" href={cacheLink?.({ namespace: ns, name: summary.recoveryCacheName })}>
                      {summary.recoveryCacheName}
                    </Link>,
                  ] as [string, React.ReactNode]]
                : []),
              [
                'Gateway',
                summary.gatewayName ? (
                  <Link key="gw" href={gatewayLink?.({ namespace: ns, name: summary.gatewayName })}>
                    {summary.gatewayName}
                    {summary.sharedGateway ? ' (shared)' : ''}
                  </Link>
                ) : (
                  'off'
                ),
              ],
            ]}
          />
          <Text variant="body-small" color="secondary">
            These are the stack's: change them through the stack (Edit), not on their own pages.
          </Text>
        </Panel>
      </Grid.Root>

      {summary.recovery && <SitePanel summary={summary} resource={resource} onChanged={onChanged ?? (() => {})} />}

      <Panel title="Sites">
        <StaticTable<StackSiteStatus & { id: string }>
          rows={sites}
          empty="No sites yet."
          columns={[
            { id: 'site', label: 'Site', isRowHeader: true, cell: s => <CellText title={s.site} description={s.active ? 'active' : 'standby'} /> },
            { id: 'location', label: 'Location', cell: s => <CellText title={s.location || '-'} /> },
            { id: 'gateway', label: 'Gateway (OPENAI_BASE_URL)', cell: s => <CellText title={s.gatewayEndpoint ?? '-'} /> },
            { id: 'database', label: 'Database', cell: s => <CellText title={s.databaseEndpoint ?? '-'} description={s.active ? 'read-write' : 'read-only replica'} /> },
            { id: 'cache', label: 'Cache', cell: s => <CellText title={s.cacheEndpoint ?? '-'} /> },
          ]}
        />
      </Panel>

      {summary.gateway && summary.sharedGateway && (
        <Panel title="Models">
          <Text variant="body-small" color="secondary">
            The stack uses shared gateway{' '}
            <Link href={gatewayLink?.({ namespace: ns, name: summary.gatewayName ?? '' })}>{summary.gatewayName}</Link> as
            client {resource.spec.gateway?.client ?? summary.name}: its models are on the gateway's page.
          </Text>
        </Panel>
      )}

      {summary.gateway && !summary.sharedGateway && (
        <Panel title="Models">
          <StaticTable<StackModel & { id: string }>
            rows={models}
            empty="No models yet: add them in Edit."
            columns={[
              { id: 'name', label: 'Model', isRowHeader: true, cell: m => <CellText title={m.name} description={m.upstreamModel ? `→ ${m.upstreamModel}` : undefined} /> },
              { id: 'schema', label: 'API', cell: m => <CellText title={m.schema ?? 'OpenAI'} /> },
              { id: 'endpoint', label: 'Endpoint', cell: m => <CellText title={m.endpoint} /> },
              { id: 'key', label: 'API key', cell: m => <CellText title={m.apiKeySecretRef ? `Secret ${m.apiKeySecretRef.name}` : 'none'} /> },
            ]}
          />
        </Panel>
      )}

      <ConnectionPanel summary={summary} />
    </Flex>
  );
};

/** One GenAIStack: sites, components, models and the wiring apps mount. */
export const StackDetailPage = () => {
  const { namespace = '', name = '' } = useParams();
  const api = useApi(basisApiRef);
  const editLink = useRouteRef(editStackRouteRef);
  const { allowed: canDelete } = usePermission({ permission: basisStackDeletePermission });
  const { allowed: canUpdate } = usePermission({ permission: basisStackUpdatePermission });
  const [deleting, setDeleting] = useState(false);
  const { value, error, retry } = useAsyncRetry(() => api.getStack(namespace, name), [api, namespace, name]);
  useInterval(retry, 10_000);

  return (
    <>
      <Header
        title={name}
        tags={[{ label: `project: ${namespace}` }, { label: 'genai stack' }]}
        customActions={
          <Flex gap="3" align="center">
            {value && <StackHealthBadge stack={value.summary} />}
            {canUpdate && editLink && value && !value.summary.deleting && (
              <ButtonLink href={editLink({ namespace, name })} variant="secondary">
                Edit
              </ButtonLink>
            )}
            {canDelete && value && (
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
        {value && <StackDetails summary={value.summary} resource={value.resource} onChanged={retry} />}
      </Container>
      {value && <DeleteDialog summary={value.summary} isOpen={deleting} onOpenChange={setDeleting} />}
    </>
  );
};
