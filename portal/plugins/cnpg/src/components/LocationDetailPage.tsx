import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  Alert,
  Button,
  ButtonLink,
  Container,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Flex,
  Grid,
  Header,
  Skeleton,
  Text,
  TextField,
} from '@backstage/ui';
import {
  cnpgLocationDeletePermission,
  cnpgLocationUpdatePermission,
  type LocationSummary,
} from '@internal/backstage-plugin-cnpg-common';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { cnpgApiRef } from '../api';
import { editLocationRouteRef, locationsRouteRef } from '../routes';
import { age, ErrorAlert, Fields, Mono, Panel } from './common';
import { ENVIRONMENT_LABELS, PROVIDER_LABELS } from './locationForm';
import { HealthChecks, LocationHealthBadge } from './LocationHealth';

const DeleteDialog = ({
  name,
  isOpen,
  onOpenChange,
}: {
  name: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const api = useApi(cnpgApiRef);
  const navigate = useNavigate();
  const listLink = useRouteRef(locationsRouteRef);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<Error>();
  const [pending, setPending] = useState(false);

  const onDelete = async () => {
    setPending(true);
    try {
      await api.deleteLocation(name);
      onOpenChange(false);
      navigate(listLink?.() ?? '/cnpg/locations');
    } catch (e) {
      setError(e as Error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={520}>
      <DialogHeader>Remove location {name}?</DialogHeader>
      <DialogBody>
        <Flex direction="column" gap="3">
          <Text>
            The portal forgets this cluster: it deletes the Location (and with it the
            ClusterProviderConfig Crossplane reaches it through) and the stored kubeconfig.
            Nothing on the cluster itself changes. Only possible once no project lists it.
          </Text>
          <TextField label={`Type "${name}" to confirm`} value={confirm} onChange={setConfirm} />
          {error && <ErrorAlert error={error} />}
        </Flex>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onPress={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          destructive
          isDisabled={confirm !== name}
          loading={pending}
          onPress={onDelete}
        >
          Remove
        </Button>
      </DialogFooter>
    </Dialog>
  );
};

const HealthAlert = ({ location }: { location: LocationSummary }) => {
  const health = location.health;
  if (!health || health.status === 'healthy') return null;
  const failed = health.checks.find(c => c.status === 'error');
  return (
    <Alert
      status={health.status === 'unreachable' ? 'danger' : 'warning'}
      title={
        health.status === 'unreachable'
          ? 'The portal cannot reach this cluster'
          : 'The cluster answers but is not healthy'
      }
      description={failed ? `${failed.name}: ${failed.message}` : undefined}
    />
  );
};

/** One location: its settings, how the portal connects, and the latest health checks. */
export const LocationDetailPage = () => {
  const { name = '' } = useParams();
  const api = useApi(cnpgApiRef);
  const editLink = useRouteRef(editLocationRouteRef);
  const { allowed: canUpdate } = usePermission({ permission: cnpgLocationUpdatePermission });
  const { allowed: canDelete } = usePermission({ permission: cnpgLocationDeletePermission });
  const [deleting, setDeleting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<Error>();

  const state = useAsyncRetry(() => api.getLocation(name), [api, name]);
  useInterval(state.retry, 30_000);
  const value = state.value;

  // Probes again on the backend (which refreshes its cache), then reloads.
  const checkNow = async () => {
    setChecking(true);
    setCheckError(undefined);
    try {
      await api.checkLocation(name);
      state.retry();
    } catch (e) {
      setCheckError(e as Error);
    } finally {
      setChecking(false);
    }
  };

  const spec = value?.spec;
  const health = value?.health;

  return (
    <>
      <Header
        title={spec?.displayName || name}
        tags={[
          { label: 'location' },
          ...(spec?.environment ? [{ label: ENVIRONMENT_LABELS[spec.environment] }] : []),
        ]}
        customActions={
          <Flex gap="3" align="center">
            {value && <LocationHealthBadge health={health} />}
            <Button variant="secondary" loading={checking} onPress={checkNow}>
              Check now
            </Button>
            {canUpdate && editLink && (
              <ButtonLink href={editLink({ name })} variant="secondary">
                Edit
              </ButtonLink>
            )}
            {canDelete && (
              <Button variant="secondary" destructive onPress={() => setDeleting(true)}>
                Remove
              </Button>
            )}
          </Flex>
        }
      />
      <Container>
        {state.error && !value && <ErrorAlert error={state.error} />}
        {!state.error && !value && <Skeleton width="100%" height={240} />}
        {value && spec && (
          <Flex direction="column" gap="4">
            {checkError && <ErrorAlert error={checkError} />}
            <HealthAlert location={value} />
            <Grid.Root columns={{ initial: '1', md: '2' }} gap="4">
              <Panel title="Location">
                <Fields
                  rows={[
                    ['Name', <Mono>{value.name}</Mono>],
                    ['Description', spec.description || '-'],
                    ['Environment', spec.environment ? ENVIRONMENT_LABELS[spec.environment] : '-'],
                    ['Provider', spec.provider ? PROVIDER_LABELS[spec.provider] : '-'],
                    ['Region', spec.region || '-'],
                    ['Owner', spec.owner || '-'],
                    ['Default StorageClass', spec.storageClass || "cluster's default"],
                    ['New databases', spec.schedulable === false ? 'not allowed' : 'allowed'],
                    [
                      'Crossplane',
                      value.status?.message ??
                        (value.providerConfig
                          ? <>
                              ClusterProviderConfig <Mono>{value.name}</Mono>
                            </>
                          : 'waiting for the Location composition'),
                    ],
                    [
                      'Operators',
                      value.status?.operators
                        ? [
                            `CloudNativePG ${value.status.operators.cloudnativepg ? 'installed' : 'missing'}`,
                            `Prometheus Operator ${value.status.operators.prometheusOperator ? 'installed' : 'missing'}`,
                            `Valkey operator ${value.status.operators.valkey ? 'installed' : 'not installed (only caches need it)'}`,
                          ].join(', ')
                        : 'unknown until Crossplane connects',
                    ],
                    ['Projects', value.projects?.length ? value.projects.join(', ') : 'none'],
                    ['Added', value.createdAt ? `${age(value.createdAt)} ago` : '-'],
                  ]}
                />
              </Panel>
              <Panel title="Connection">
                <Fields
                  rows={[
                    ['API server', <Mono>{value.connection.server}</Mono>],
                    ['Context', <Mono>{value.connection.context}</Mono>],
                    ['Namespace', value.connection.namespace || '-'],
                    ['Authentication', value.connection.auth],
                    [
                      'TLS',
                      value.connection.insecureSkipTlsVerify
                        ? 'not verified (insecure-skip-tls-verify)'
                        : 'verified',
                    ],
                    ['Kubernetes', health?.kubernetesVersion ?? '-'],
                    [
                      'Nodes',
                      health?.nodes ? `${health.nodes.ready} of ${health.nodes.total} Ready` : '-',
                    ],
                    ['Latency', health?.latencyMs !== undefined ? `${health.latencyMs} ms` : '-'],
                  ]}
                />
              </Panel>
            </Grid.Root>
            {health && (
              <Panel title="Health checks">
                <HealthChecks health={health} />
              </Panel>
            )}
          </Flex>
        )}
      </Container>
      <DeleteDialog name={name} isOpen={deleting} onOpenChange={setDeleting} />
    </>
  );
};
