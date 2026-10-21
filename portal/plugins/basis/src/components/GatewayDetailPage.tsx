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
  basisGatewayCredentialsReadPermission,
  basisGatewayDeletePermission,
  basisGatewayUpdatePermission,
  type GatewayKey,
  type GatewayModel,
  type GatewaySiteStatus,
  type ModelGateway,
  type ModelGatewaySummary,
} from '@internal/backstage-plugin-basis-common';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { basisApiRef } from '../api';
import { editGatewayRouteRef, gatewaysRouteRef, projectRouteRef, stackRouteRef } from '../routes';
import { StaticTable } from './ClusterDetails';
import { age, ErrorAlert, Fields, GatewayHealthBadge, gatewayHealth, Mono, Panel } from './common';

const DeleteDialog = ({
  summary,
  usedBy,
  isOpen,
  onOpenChange,
}: {
  summary: ModelGatewaySummary;
  usedBy: string[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const api = useApi(basisApiRef);
  const navigate = useNavigate();
  const listLink = useRouteRef(gatewaysRouteRef);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<Error>();
  const [pending, setPending] = useState(false);
  const onDelete = async () => {
    setPending(true);
    try {
      await api.deleteGateway(summary.namespace, summary.name);
      onOpenChange(false);
      navigate(listLink?.() ?? '/basis/gateways');
    } catch (e) {
      setError(e as Error);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={560}>
      <DialogHeader>Delete gateway {summary.namespace}/{summary.name}?</DialogHeader>
      <DialogBody>
        <Flex direction="column" gap="3">
          <Text>
            Agent Router goes from every site and the {summary.clients.length} client key(s) stop working. The providers'
            key Secrets stay.
          </Text>
          {usedBy.length > 0 && (
            <Alert status="warning" title={`Used by stack(s) ${usedBy.join(', ')}`} description="Point them at another gateway first." />
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

/** The clients and, with basis.gateway.credentials.read, their keys. */
const KeysPanel = ({ summary }: { summary: ModelGatewaySummary }) => {
  const api = useApi(basisApiRef);
  const { allowed } = usePermission({ permission: basisGatewayCredentialsReadPermission });
  const [keys, setKeys] = useState<GatewayKey[]>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const toggle = async () => {
    if (keys) {
      setKeys(undefined);
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      setKeys(await api.getGatewayKeys(summary.namespace, summary.name));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <Panel title="Clients">
      <Flex direction="column" gap="3">
        <Text variant="body-small" color="secondary">
          In the project's location, any OpenAI SDK: <Mono>OPENAI_BASE_URL={summary.endpoint}</Mono> and as{' '}
          <Mono>OPENAI_API_KEY</Mono> the client's key from Secret{' '}
          <Mono>
            {summary.namespace}/{summary.keysSecret}
          </Mono>
          .
        </Text>
        <Fields
          rows={summary.clients.map(c => [
            c,
            keys ? <Mono key={c}>{keys.find(k => k.client === c)?.key ?? 'not generated yet'}</Mono> : '••••••',
          ])}
        />
        {allowed && (
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

export const GatewayDetails = ({
  summary,
  resource,
  usedBy,
}: {
  summary: ModelGatewaySummary;
  resource: ModelGateway;
  usedBy: string[];
}) => {
  const projectLink = useRouteRef(projectRouteRef);
  const stackLink = useRouteRef(stackRouteRef);
  const h = gatewayHealth(summary);
  const ns = summary.namespace;
  const models = (resource.spec.models ?? []).map(m => ({ ...m, id: m.name }));
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
              ['Project', summary.project ? <Link href={projectLink?.({ name: summary.project })}>{summary.project}</Link> : ns],
              ['Endpoint (OPENAI_BASE_URL)', <Mono key="ep">{summary.endpoint}</Mono>],
              ['Sites', summary.recovery ? `protected + recovery (standby); active: ${summary.activeSite}` : 'protected only'],
              ['Owner', summary.owner ?? '-'],
              ['Created', summary.createdAt ? `${new Date(summary.createdAt).toLocaleString()} (${age(summary.createdAt)} ago)` : '-'],
            ]}
          />
        </Panel>
        <Panel title="Used by">
          <Flex direction="column" gap="2">
            {usedBy.length === 0 && (
              <Text variant="body-small" color="secondary">
                No GenAI stacks. Apps and agents call it with a client key; a stack shares it with gateway.ref.
              </Text>
            )}
            {usedBy.map(s => (
              <Link key={s} href={stackLink?.({ namespace: ns, name: s })}>
                Stack {s}
                {summary.stack === s ? ' (its own)' : ''}
              </Link>
            ))}
          </Flex>
        </Panel>
      </Grid.Root>

      <Panel title="Sites">
        <StaticTable<GatewaySiteStatus & { id: string }>
          rows={sites}
          empty="No sites yet."
          columns={[
            { id: 'site', label: 'Site', isRowHeader: true, cell: s => <CellText title={s.site} description={s.active ? 'active' : 'standby'} /> },
            { id: 'location', label: 'Location', cell: s => <CellText title={s.location || '-'} /> },
            { id: 'replicas', label: 'Replicas', cell: s => <CellText title={s.replicas === undefined ? '-' : String(s.replicas)} /> },
          ]}
        />
      </Panel>

      <Panel title="Models">
        <StaticTable<GatewayModel & { id: string }>
          rows={models}
          empty="No models yet: add them in Edit."
          columns={[
            { id: 'name', label: 'Model', isRowHeader: true, cell: m => <CellText title={m.name} description={m.upstreamModel ? `→ ${m.upstreamModel}` : undefined} /> },
            { id: 'schema', label: 'API', cell: m => <CellText title={m.schema ?? 'OpenAI'} /> },
            { id: 'endpoint', label: 'Endpoint', cell: m => <CellText title={m.endpoint} /> },
            { id: 'key', label: 'Provider key', cell: m => <CellText title={m.apiKeySecretRef ? `Secret ${m.apiKeySecretRef.name}` : 'none'} /> },
          ]}
        />
      </Panel>

      <KeysPanel summary={summary} />
    </Flex>
  );
};

/** One ModelGateway: sites, models, clients and who uses it. */
export const GatewayDetailPage = () => {
  const { namespace = '', name = '' } = useParams();
  const api = useApi(basisApiRef);
  const editLink = useRouteRef(editGatewayRouteRef);
  const stackLink = useRouteRef(stackRouteRef);
  const { allowed: canDelete } = usePermission({ permission: basisGatewayDeletePermission });
  const { allowed: canUpdate } = usePermission({ permission: basisGatewayUpdatePermission });
  const [deleting, setDeleting] = useState(false);
  const { value, error, retry } = useAsyncRetry(() => api.getGateway(namespace, name), [api, namespace, name]);
  useInterval(retry, 10_000);
  const stack = value?.summary.stack;

  return (
    <>
      <Header
        title={name}
        tags={[{ label: `project: ${namespace}` }, { label: 'model gateway' }]}
        customActions={
          <Flex gap="3" align="center">
            {value && <GatewayHealthBadge gateway={value.summary} />}
            {stack && stackLink && (
              <ButtonLink href={stackLink({ namespace, name: stack })} variant="secondary">
                Part of stack {stack}
              </ButtonLink>
            )}
            {canUpdate && editLink && value && !value.summary.deleting && !stack && (
              <ButtonLink href={editLink({ namespace, name })} variant="secondary">
                Edit
              </ButtonLink>
            )}
            {canDelete && value && !stack && (
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
        {value && <GatewayDetails summary={value.summary} resource={value.resource} usedBy={value.stacks} />}
      </Container>
      {value && <DeleteDialog summary={value.summary} usedBy={value.stacks} isOpen={deleting} onOpenChange={setDeleting} />}
    </>
  );
};
