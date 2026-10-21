import { useApi } from '@backstage/frontend-plugin-api';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  CellText,
  type ColumnConfig,
  Flex,
  Grid,
  Skeleton,
  Table,
  Text,
  useTable,
} from '@backstage/ui';
import {
  clusterProfile,
  type ClusterConnection,
  type ClusterEvent,
  type ClusterLocationStatus,
  type Condition,
  type InstancePod,
  pgauditLog,
  type PostgresClusterDetails,
  PROFILES,
} from '@internal/backstage-plugin-cnpg-common';
import { ReactNode, useState } from 'react';
import { cnpgApiRef } from '../api';
import { age, Fields, health, Mono } from './common';

export const StaticTable = <T extends { id: string }>({
  rows,
  columns,
  empty,
}: {
  rows: T[];
  columns: ColumnConfig<T>[];
  empty: string;
}) => {
  const { tableProps } = useTable({
    mode: 'complete',
    data: rows,
    paginationOptions: { pageSize: Math.max(rows.length, 1) },
  });
  return (
    <Table
      columnConfig={columns}
      {...tableProps}
      pagination={{ type: 'none' }}
      emptyState={<Text color="secondary">{empty}</Text>}
    />
  );
};

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <Card>
    <CardHeader>
      <Text variant="title-x-small" as="h3">
        {title}
      </Text>
    </CardHeader>
    <CardBody>{children}</CardBody>
  </Card>
);

const onOff = (v: unknown) => (v ? 'enabled' : 'disabled');

/**
 * A connection URI, masked until asked for. The password is only fetched
 * (`load`: live from the Secret in the location) when the user shows or
 * copies it. `external: false` notes that the URI has the in-cluster host.
 */
export const ConnectionUri = ({
  load: fetchConnection,
  masked,
  inClusterNote = 'The load balancer has no address yet: this is the in-cluster host.',
}: {
  load: () => Promise<Pick<ClusterConnection, 'uri'> & { external?: boolean }>;
  masked: string;
  /** Shown when the URI has the in-cluster host (`external: false`). */
  inClusterNote?: string;
}) => {
  const [conn, setConn] = useState<Pick<ClusterConnection, 'uri'> & { external?: boolean }>();
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const load = async () => {
    if (conn) return conn;
    setPending(true);
    setError(undefined);
    try {
      const c = await fetchConnection();
      setConn(c);
      return c;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setPending(false);
    }
  };
  const toggle = async () => {
    if (shown) setShown(false);
    else if (await load()) setShown(true);
  };
  const copy = async () => {
    // The clipboard write must start inside the click: one begun after
    // awaiting the fetch is refused ("Document is not focused"). A
    // ClipboardItem takes the URI as a promise, so it can.
    const text = load().then(c => {
      if (!c) throw new Error('no connection URI');
      return c.uri;
    });
    try {
      if (conn || typeof ClipboardItem === 'undefined') {
        await navigator.clipboard.writeText(await text);
      } else {
        const blob = text.then(t => new Blob([t], { type: 'text/plain' }));
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      // A failed fetch has already set its own error.
      if (await text.then(() => true, () => false)) {
        setError(`Couldn't copy: ${(e as Error).message}. Use Show and copy it by hand.`);
      }
    }
  };

  return (
    <Flex direction="column" gap="1">
      <Mono>{shown && conn ? conn.uri : masked}</Mono>
      <Flex gap="2">
        <Button size="small" variant="secondary" loading={pending} onPress={toggle}>
          {shown ? 'Hide' : 'Show'}
        </Button>
        <Button size="small" variant="secondary" isDisabled={pending} onPress={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </Flex>
      {conn && conn.external === false && (
        <Text variant="body-small" color="secondary">
          {inClusterNote}
        </Text>
      )}
      {error && (
        <Text variant="body-small" color="danger">
          {error}
        </Text>
      )}
    </Flex>
  );
};

/**
 * Everything about one PostgresCluster: health, connection details,
 * configuration, instance pods, conditions and recent events. Shared by the
 * portal detail page and the catalog entity tab.
 */
export const ClusterDetails = ({ details }: { details: PostgresClusterDetails }) => {
  const api = useApi(cnpgApiRef);
  const { summary, resource, pods, events, cnpgStatus } = details;
  const spec = resource.spec;
  const status = resource.status ?? {};
  // What the instances run with (a size resolved by the composition), else the spec's.
  const running = status.sizing?.resources ?? spec.resources ?? {};
  const tuned = Object.entries(status.sizing?.parameters ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  // The size's setting, under the cluster's own (as the composition merges them).
  const auditLog = pgauditLog({ ...status.sizing?.parameters, ...spec.postgresql?.parameters });
  // Each database's extensions: the bootstrap database's, then databases[]'.
  const extensions = [
    { db: spec.database?.name ?? 'app', names: spec.database?.extensions },
    ...(spec.databases ?? []).map((d: any) => ({ db: d.name, names: d.extensions })),
  ].filter(d => Array.isArray(d.names) && d.names.length);
  const ns = summary.namespace;
  const h = health(summary);
  const exposed = Boolean(spec.expose?.enabled);
  let externalAccess: ReactNode = `internal only: reachable from workloads in ${summary.primaryLocation || 'its location'}`;
  if (exposed) {
    externalAccess = details.externalHost ? (
      <Mono>
        {details.externalHost}:5432 (sslmode=verify-full, CA in Secret {ns}/{summary.name}-ca)
      </Mono>
    ) : (
      'exposed; waiting for the load balancer address'
    );
  }

  // Every location's pods have the same names (orders-db-1, ...).
  const podRows = pods.map(p => ({ ...p, id: `${p.location}/${p.name}` }));
  const conditionRows = (status.conditions ?? []).map(c => ({ ...c, id: c.type }));
  const eventRows = events.map((e, i) => ({ ...e, id: `${i}` }));
  const locationRows = (status.locations ?? []).map(l => ({ ...l, id: l.location }));
  const multiLocation = locationRows.length > 1;
  const locationColumn = <T extends { location: string }>() =>
    multiLocation
      ? [{ id: 'location', label: 'Location', cell: (r: T) => <CellText title={r.location} /> }]
      : [];

  return (
    <Flex direction="column" gap="4">
      {h !== 'healthy' && (
        <Alert
          status={h === 'degraded' ? 'warning' : 'info'}
          title={h === 'deleting' ? 'Deleting' : summary.phase}
          description={summary.message}
        />
      )}
      {details.unreachable?.map(u => (
        <Alert
          key={u.location}
          status="warning"
          title={`Can't read location ${u.location}`}
          description={`Its pods and events are missing below: ${u.message}`}
        />
      ))}

      <Grid.Root columns={{ initial: '1', md: '2' }} gap="4">
        <Section title="Overview">
          <Fields
            rows={[
              ['Phase', summary.phase],
              ['Instances ready', `${summary.readyInstances} / ${summary.instances}`],
              ['Primary', summary.currentPrimary ?? '-'],
              ['Location', multiLocation
                ? `${summary.primaryLocation} (primary, ${summary.primarySite} site) + replica cluster in ${locationRows.find(l => l.location !== summary.primaryLocation)?.location}`
                : summary.location || 'not placed yet'],
              ['PostgreSQL', status.image ? <Mono>{status.image.split('@')[0]}</Mono> : `${spec.postgresVersion ?? '-'}`],
              ['Timeline', cnpgStatus?.timelineID ? String(cnpgStatus.timelineID) : '-'],
              ['Owner', summary.owner ?? '-'],
              ['Created', summary.createdAt ? `${new Date(summary.createdAt).toLocaleString()} (${age(summary.createdAt)} ago)` : '-'],
            ]}
          />
        </Section>

        <Section title="Connect">
          <Fields
            rows={[
              ['Read-write', <Mono>{status.endpoints?.readWrite}:5432</Mono>],
              ['Read-only', <Mono>{status.endpoints?.readOnly}:5432</Mono>],
              ...(status.endpoints?.pooler
                ? [['Pooler (rw)', <Mono>{status.endpoints.pooler}:5432</Mono>] as [string, ReactNode]]
                : []),
              ...(status.endpoints?.poolerReadOnly
                ? [['Pooler (ro)', <Mono>{status.endpoints.poolerReadOnly}:5432</Mono>] as [string, ReactNode]]
                : []),
              ...(summary.primaryLocation
                ? [['In location', multiLocation
                    ? `${summary.primaryLocation}: the services and Secret exist under the same names in both sites`
                    : summary.primaryLocation] as [string, ReactNode]]
                : []),
              ['Database', `${spec.database?.name ?? 'app'} (owner ${spec.database?.owner ?? 'app'})`],
              [
                'Extensions',
                extensions.length ? (
                  <Flex direction="column" gap="0">
                    {extensions.map(d => (
                      <Mono key={d.db}>
                        {extensions.length > 1 || d.db !== (spec.database?.name ?? 'app') ? `${d.db}: ` : ''}
                        {d.names.join(', ')}
                      </Mono>
                    ))}
                  </Flex>
                ) : (
                  'none'
                ),
              ],
              ['External access', externalAccess],
              ['Credentials', <Mono>Secret {ns}/{status.secrets?.app}</Mono>],
              [
                'Connection URI',
                <ConnectionUri
                  load={() => api.getConnection(ns, summary.name)}
                  inClusterNote={
                    exposed
                      ? undefined
                      : 'Internal only: use it from workloads in the same location (spec.expose is off).'
                  }
                  masked={`postgresql://${spec.database?.owner ?? 'app'}:••••••@${details.externalHost ?? status.endpoints?.readWrite}:5432/${spec.database?.name ?? 'app'}`}
                />,
              ],
            ]}
          />
        </Section>

        <Section title="Storage & resources">
          <Fields
            rows={[
              ['Data volume', `${spec.storage?.size ?? '-'}${spec.storage?.storageClass ? ` (${spec.storage.storageClass})` : ''}`],
              ['WAL volume', spec.walStorage ? `${spec.walStorage.size}` : 'shared with data'],
              ['Size', spec.size ? spec.size.toUpperCase() : 'custom'],
              ['Workload profile', PROFILES[clusterProfile(spec)].displayName],
              ['CPU request', running.requests?.cpu ?? '-'],
              ['Memory', `${running.requests?.memory ?? '-'} request / ${running.limits?.memory ?? '-'} limit`],
              ...(tuned
                ? ([['PostgreSQL tuned', <Mono>{tuned}</Mono>]] as Array<[string, ReactNode]>)
                : []),
              ['Anti-affinity', spec.highAvailability?.podAntiAffinityType ?? 'preferred'],
              ['Sync replicas', String(spec.highAvailability?.synchronousReplicas ?? 0)],
            ]}
          />
        </Section>

        <Section title="Pooling, backups & monitoring">
          <Fields
            rows={[
              ['PgBouncer', spec.pooler?.enabled ? `${spec.pooler.instances ?? 2} × ${spec.pooler.poolMode ?? 'transaction'} mode` : 'disabled'],
              ['Backups', spec.backup?.enabled ? <Mono>{spec.backup.destinationPath}</Mono> : 'disabled'],
              ...(spec.backup?.enabled
                ? ([
                    ['Schedule', <Mono>{spec.backup.schedule}</Mono>],
                    ['Retention', spec.backup.retentionPolicy ?? '30d'],
                    ['Last backup', status.backup?.lastSuccessfulBackup || 'none yet'],
                    ['Recoverable from', status.backup?.firstRecoverabilityPoint || '-'],
                  ] as Array<[string, ReactNode]>)
                : []),
              ['Metrics (PodMonitor)', onOff(spec.monitoring?.enabled ?? true)],
              ['Alerts (PrometheusRule)', onOff(spec.monitoring?.prometheusRule?.enabled ?? true)],
              ['Grafana dashboard', status.monitoring?.dashboardUid ? <Mono>{status.monitoring.dashboardUid}</Mono> : 'disabled'],
              ['Audit logging (pgaudit)', auditLog ? <Mono>{auditLog}</Mono> : 'disabled'],
            ]}
          />
        </Section>
      </Grid.Root>

      {multiLocation && (
        <Section title="Sites">
          <StaticTable<ClusterLocationStatus & { id: string }>
            rows={locationRows}
            empty="No locations reported yet."
            columns={[
              { id: 'location', label: 'Location', isRowHeader: true, cell: l => <CellText title={l.location} /> },
              { id: 'site', label: 'Site', cell: l => <CellText title={l.site ?? '-'} /> },
              {
                id: 'role',
                label: 'Role',
                cell: l => (
                  <CellText
                    title={l.role}
                    description={l.role === 'promoting' ? 'waiting for the demotion token' : undefined}
                  />
                ),
              },
              { id: 'phase', label: 'Phase', cell: l => <CellText title={l.phase ?? '-'} /> },
              { id: 'ready', label: 'Instances ready', cell: l => <CellText title={`${l.readyInstances ?? 0}/${l.instances ?? 0}`} /> },
              { id: 'primary', label: 'Primary instance', cell: l => <CellText title={l.currentPrimary || '-'} /> },
            ]}
          />
        </Section>
      )}

      <Section title="Instances">
        <StaticTable<InstancePod & { id: string }>
          rows={podRows}
          empty="No pods yet."
          columns={[
            { id: 'name', label: 'Pod', isRowHeader: true, cell: p => <CellText title={p.name} /> },
            ...locationColumn<InstancePod & { id: string }>(),
            { id: 'role', label: 'Role', cell: p => <CellText title={p.role} /> },
            { id: 'phase', label: 'Phase', cell: p => <CellText title={p.phase} /> },
            { id: 'ready', label: 'Ready', cell: p => <CellText title={p.ready ? 'yes' : 'no'} /> },
            { id: 'node', label: 'Node', cell: p => <CellText title={p.node ?? '-'} /> },
            { id: 'restarts', label: 'Restarts', cell: p => <CellText title={String(p.restarts)} /> },
            { id: 'age', label: 'Age', cell: p => <CellText title={age(p.createdAt)} /> },
          ]}
        />
      </Section>

      <Section title="Conditions">
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
      </Section>

      <Section title="Recent events">
        <StaticTable<ClusterEvent & { id: string }>
          rows={eventRows}
          empty="No recent events."
          columns={[
            { id: 'type', label: 'Type', cell: e => <CellText title={e.type} /> },
            { id: 'reason', label: 'Reason', isRowHeader: true, cell: e => <CellText title={e.reason} /> },
            ...locationColumn<ClusterEvent & { id: string }>(),
            { id: 'object', label: 'Object', cell: e => <CellText title={e.object} /> },
            { id: 'message', label: 'Message', cell: e => <CellText title={e.message} /> },
            { id: 'last', label: 'Last seen', cell: e => <CellText title={`${age(e.lastSeen)} ago${e.count > 1 ? ` (×${e.count})` : ''}`} /> },
          ]}
        />
      </Section>
    </Flex>
  );
};

export const ClusterDetailsSkeleton = () => (
  <Flex direction="column" gap="4">
    <Skeleton height={120} />
    <Skeleton height={240} />
  </Flex>
);

