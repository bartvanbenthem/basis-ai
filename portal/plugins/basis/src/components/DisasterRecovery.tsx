import { useApi } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Flex,
  Grid,
  Text,
  TextField,
} from '@backstage/ui';
import {
  allowedPromotions,
  cnpgClusterFailoverPermission,
  cnpgClusterSwitchoverPermission,
  type ClusterLocationStatus,
  type PostgresClusterDetails,
  primaryState,
  type PromotionRequest,
  type Site,
} from '@internal/backstage-plugin-cnpg-common';
import { useState } from 'react';
import { cnpgApiRef } from '../api';
import { ErrorAlert, Fields, Panel, StatusDot, type Health } from './common';

const SITES: Site[] = ['protected', 'recovery'];

/** One word for a site: unreachable when its location can't be read, otherwise its Cluster's readiness. */
function siteHealth(
  entry: ClusterLocationStatus | undefined,
  unreachable: boolean,
): Health {
  if (unreachable) return 'unreachable';
  if (!entry) return 'progressing';
  return entry.ready ? 'healthy' : 'degraded';
}

const ROLE: Record<string, string> = {
  primary: 'Primary',
  replica: 'Replica cluster',
  promoting: 'Promoting: waiting for the demotion token',
};

const SiteCard = ({
  site,
  location,
  entry,
  unreachable,
}: {
  site: Site;
  location?: string;
  entry?: ClusterLocationStatus;
  unreachable?: string;
}) => (
  <Card>
    <CardHeader>
      <Flex justify="between" align="center">
        <Flex direction="column" gap="1">
          <Text variant="title-x-small" as="h3">
            {site === 'protected' ? 'Protected site' : 'Recovery site'}
          </Text>
          <Text variant="body-small" color="secondary">
            {location ?? 'no location'}
          </Text>
        </Flex>
        <StatusDot health={siteHealth(entry, Boolean(unreachable))} />
      </Flex>
    </CardHeader>
    <CardBody>
      <Fields
        rows={[
          ['Role', entry ? ROLE[entry.role] ?? entry.role : 'not running'],
          ['Phase', entry?.phase ?? '-'],
          ['Instances ready', entry ? `${entry.readyInstances ?? 0} / ${entry.instances ?? 0}` : '-'],
          ['Primary instance', entry?.currentPrimary || '-'],
          ...(unreachable ? [['Unreachable', unreachable] as [string, string]] : []),
        ]}
      />
    </CardBody>
  </Card>
);

const PromoteDialog = ({
  details,
  request,
  onClose,
  onDone,
}: {
  details: PostgresClusterDetails;
  request: PromotionRequest;
  onClose: () => void;
  onDone: () => void;
}) => {
  const api = useApi(cnpgApiRef);
  const { name, namespace } = details.summary;
  const state = primaryState(details.resource);
  const failover = request.mode === 'Failover';
  const from = (details.resource.status?.locations ?? []).find(l => l.site === state.current);
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error>();

  const submit = async () => {
    setPending(true);
    setError(undefined);
    try {
      await api.promoteCluster(namespace, name, request);
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
        {failover ? 'Fail over' : 'Switch over'} {name} to the {request.site} site?
      </DialogHeader>
      <DialogBody>
        <Flex direction="column" gap="3">
          {failover ? (
            <>
              <Text>
                The {request.site} site is promoted right away, without waiting for the
                current primary. Transactions it hadn't archived yet are lost. When the{' '}
                {state.current} site comes back it follows the new primary; if its timeline
                diverged, its instances have to be recreated.
              </Text>
              {from?.ready && (
                <Alert
                  status="warning"
                  title={`The ${state.current} site looks healthy`}
                  description="Prefer a switchover: it loses nothing. Fail over only when that site is down or its primary is stuck."
                />
              )}
              <TextField label={`Type "${name}" to confirm`} value={confirm} onChange={setConfirm} />
            </>
          ) : (
            <Text>
              The primary in the {state.current} site is demoted first. The {request.site} site
              takes over once it has replayed everything the old primary wrote, so no
              transaction is lost. Writes stop until then, usually a minute or two. If the{' '}
              {state.current} site can't hand over, you can fail over from this page instead.
            </Text>
          )}
          <Text variant="body-small" color="secondary">
            Applications connect through the services of the site that is primary. The{' '}
            <code>-app</code> Secret is generated per site, unless the role's password is managed.
          </Text>
          {error && <ErrorAlert error={error} />}
        </Flex>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          destructive={failover}
          isDisabled={failover && confirm !== name}
          loading={pending}
          onPress={submit}
        >
          {failover ? 'Fail over' : 'Switch over'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
};

/**
 * The Disaster recovery tab: both sites of a geo-replicated cluster and the
 * actions that move its primary between them. `onChanged` reloads the
 * details after an action.
 */
export const DisasterRecovery = ({
  details,
  onChanged,
}: {
  details: PostgresClusterDetails;
  onChanged: () => void;
}) => {
  const { allowed: canSwitchover } = usePermission({ permission: cnpgClusterSwitchoverPermission });
  const { allowed: canFailover } = usePermission({ permission: cnpgClusterFailoverPermission });
  const [request, setRequest] = useState<PromotionRequest>();
  const { resource } = details;
  const status = resource.status ?? {};
  const state = primaryState(resource);
  const sites = { protected: status.sites?.protected ?? details.summary.location, recovery: status.sites?.recovery ?? details.summary.recoveryLocation };
  const entries = status.locations ?? [];
  const actions = allowedPromotions(resource).filter(a =>
    a.mode === 'Failover' ? canFailover : canSwitchover,
  );
  const switchover = actions.find(a => a.mode === 'Switchover');
  const failover = actions.find(a => a.mode === 'Failover');

  return (
    <Flex direction="column" gap="4">
      {!state.geoReplication && (
        <Alert
          status="info"
          title={sites.recovery ? 'Geo replication is off' : 'The project has no recovery site'}
          description={
            sites.recovery
              ? `Turn it on in Edit to keep a replica cluster in ${sites.recovery} that this page can promote.`
              : 'Add a recovery location to the project, then turn geo replication on for this cluster.'
          }
        />
      )}
      {state.switching && (
        <Alert
          status="info"
          title={`${state.promotion} to the ${state.target} site in progress`}
          description={
            details.summary.message ??
            (state.promotion === 'Switchover'
              ? `Waiting for the ${state.current} site to hand over. If it is down, fail over instead.`
              : `Promoting the ${state.target} site.`)
          }
        />
      )}

      <Grid.Root columns={{ initial: '1', md: '2' }} gap="4">
        {SITES.map(site => (
          <SiteCard
            key={site}
            site={site}
            location={sites[site]}
            entry={entries.find(l => l.site === site)}
            unreachable={details.unreachable?.find(u => u.location === sites[site])?.message}
          />
        ))}
      </Grid.Root>

      {state.geoReplication && (
        <Panel title="Move the primary">
          <Flex direction="column" gap="3">
            {switchover && (
              <Flex justify="between" align="center" gap="4">
                <Text variant="body-small">
                  <strong>Switchover</strong> to the {switchover.site} site ({sites[switchover.site]}):
                  planned, demotes the primary first, loses nothing.
                </Text>
                <Button variant="primary" onPress={() => setRequest(switchover)}>
                  Switch over
                </Button>
              </Flex>
            )}
            {failover && (
              <Flex justify="between" align="center" gap="4">
                <Text variant="body-small">
                  <strong>Failover</strong> to the {failover.site} site ({sites[failover.site]}): for
                  when the {state.current} site is down. Unarchived transactions are lost.
                </Text>
                <Button variant="secondary" destructive onPress={() => setRequest(failover)}>
                  Fail over
                </Button>
              </Flex>
            )}
            {!switchover && !failover && (
              <Text variant="body-small" color="secondary">
                {allowedPromotions(resource).length
                  ? "You may not move this cluster's primary."
                  : `Nothing to do until the ${state.promotion.toLowerCase()} finishes.`}
              </Text>
            )}
          </Flex>
        </Panel>
      )}

      <Panel title="WAL archive">
        <Fields
          rows={[
            ['How the sites connect', 'The replica cluster replays the primary\'s WAL archive from the backup object store; the sites need no network path to each other.'],
            ['Last base backup', status.backup?.lastSuccessfulBackup || 'none yet'],
            ['Recoverable from', status.backup?.firstRecoverabilityPoint || '-'],
          ]}
        />
      </Panel>

      {request && (
        <PromoteDialog
          details={details}
          request={request}
          onClose={() => setRequest(undefined)}
          onDone={() => {
            setRequest(undefined);
            onChanged();
          }}
        />
      )}
    </Flex>
  );
};
