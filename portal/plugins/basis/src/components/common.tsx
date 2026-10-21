import { Alert, Button, Card, CardBody, CardHeader, Flex, Grid, Text } from '@backstage/ui';
import type {
  BucketState,
  BucketUsage,
  VolumeState,
  PostgresClusterSummary,
  ProjectSummary,
  ValkeyCacheSummary,
} from '@internal/backstage-plugin-cnpg-common';
import { ReactNode } from 'react';

/** Database glyph used for the nav item and the entity tab. */
export const PostgresIcon = () => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
    <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
  </svg>
);

export type Health = 'healthy' | 'progressing' | 'degraded' | 'deleting' | 'unreachable';

/**
 * One word for the state of a cluster, combining Crossplane's Ready
 * condition (every composed object exists, Cluster healthy) with CNPG's
 * instance counts.
 */
export function health(c: PostgresClusterSummary): Health {
  if (c.deleting) return 'deleting';
  if (c.ready) return 'healthy';
  if (c.readyInstances > 0 && c.readyInstances < c.instances) return 'degraded';
  return 'progressing';
}

const HEALTH: Record<Health, { label: string; color: string }> = {
  healthy: { label: 'Healthy', color: 'var(--bui-fg-positive, #1f883d)' },
  progressing: { label: 'Provisioning', color: 'var(--bui-fg-info, #0969da)' },
  degraded: { label: 'Degraded', color: 'var(--bui-fg-warning, #9a6700)' },
  deleting: { label: 'Deleting', color: 'var(--bui-fg-secondary, #59636e)' },
  unreachable: { label: 'Unreachable', color: 'var(--bui-fg-danger, #d1242f)' },
};

/** A project is healthy once its namespace, Prometheus and Grafana are up. */
export function projectHealth(p: ProjectSummary): Health {
  if (p.deleting) return 'deleting';
  return p.ready ? 'healthy' : 'progressing';
}

/** A cache from Crossplane's Ready condition and the operator's state. */
export function cacheHealth(c: ValkeyCacheSummary): Health {
  if (c.deleting) return 'deleting';
  if (c.ready) return 'healthy';
  if (c.state === 'Degraded' || c.state === 'Failed') return 'degraded';
  return 'progressing';
}

/** `label` replaces the health's own word, e.g. "Reachable" for healthy. */
export const StatusDot = ({ health: h, label }: { health: Health; label?: string }) => {
  const { color } = HEALTH[h];
  return (
    <Flex align="center" gap="1">
      <span
        aria-hidden="true"
        style={{ width: 8, height: 8, borderRadius: '50%', background: color, flex: 'none' }}
      />
      <Text variant="body-small">{label ?? HEALTH[h].label}</Text>
    </Flex>
  );
};

export const HealthBadge = ({ cluster }: { cluster: PostgresClusterSummary }) => (
  <StatusDot health={health(cluster)} />
);

export const CacheHealthBadge = ({ cache }: { cache: ValkeyCacheSummary }) => (
  <StatusDot health={cacheHealth(cache)} />
);

export const ProjectHealthBadge = ({ project }: { project: ProjectSummary }) => (
  <StatusDot health={projectHealth(project)} />
);

const BUCKET_STATE: Record<BucketState, { health: Health; label: string }> = {
  project: { health: 'healthy', label: 'In use' },
  cosi: { health: 'progressing', label: 'COSI claim' },
  orphaned: { health: 'degraded', label: 'Orphaned' },
};

export const BucketStateBadge = ({ state }: { state: BucketState }) => (
  <StatusDot health={BUCKET_STATE[state].health} label={BUCKET_STATE[state].label} />
);

const VOLUME_STATE: Record<VolumeState, { health: Health; label: string }> = {
  'in-use': { health: 'healthy', label: 'In use' },
  orphaned: { health: 'degraded', label: 'Orphaned' },
  released: { health: 'degraded', label: 'Released' },
};

export const VolumeStateBadge = ({ state }: { state: VolumeState }) => (
  <StatusDot health={VOLUME_STATE[state].health} label={VOLUME_STATE[state].label} />
);

/** 1536 -> "1.5 KiB". */
export function bytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** Object count and size; "at least" when the backend stopped counting. */
export function usageText(u?: BucketUsage): { objects: string; size: string } {
  if (!u) return { objects: '-', size: '-' };
  const prefix = u.truncated ? '≥ ' : '';
  return { objects: `${prefix}${u.objects.toLocaleString()}`, size: `${prefix}${bytes(u.bytes)}` };
}

export function age(timestamp?: string): string {
  if (!timestamp) return '-';
  const seconds = Math.max(0, (Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export type TimeRange = '1h' | '6h' | '24h' | '7d';

/**
 * URL of a cluster's CNPG dashboard. `grafanaUrl` may contain "{namespace}"
 * for setups with one Grafana per namespace. With `embed`, Grafana's chrome is
 * hidden (kiosk) and the dark theme matches the portal.
 */
export function grafanaLink(
  grafanaUrl: string | undefined,
  uid: string | undefined,
  opts: { namespace?: string; cluster?: string; embed?: boolean; range?: TimeRange } = {},
): string | undefined {
  if (!grafanaUrl || !uid) return undefined;
  const base = grafanaUrl.replace(/\{namespace\}/g, opts.namespace ?? '').replace(/\/$/, '');
  const params = new URLSearchParams();
  if (opts.namespace) params.set('var-namespace', opts.namespace);
  if (opts.cluster) params.set('var-cluster', opts.cluster);
  if (opts.range) {
    params.set('from', `now-${opts.range}`);
    params.set('to', 'now');
  }
  if (opts.embed) {
    params.set('theme', 'dark');
    params.set('refresh', '30s');
  }
  // Bare flags: kiosk hides Grafana's chrome; the _dash.* flags (Grafana 11.3+)
  // hide the time picker and variables, which the portal already controls.
  const flags = opts.embed ? '&kiosk&_dash.hideTimePicker&_dash.hideVariables&_dash.hideLinks' : '';
  const query = params.toString() + flags;
  return `${base}/d/${encodeURIComponent(uid)}${query ? `?${query.replace(/^&/, '')}` : ''}`;
}

export const ErrorAlert = ({ error }: { error: Error }) => (
  <Alert status="danger" title="Request failed" description={error.message} />
);

/** Label/value rows inside a card. */
export const Fields = ({ rows }: { rows: Array<[string, ReactNode]> }) => (
  <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '8px 24px', margin: 0 }}>
    {rows.map(([label, value]) => (
      <div key={label} style={{ display: 'contents' }}>
        <dt>
          <Text variant="body-small" color="secondary">{label}</Text>
        </dt>
        <dd style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>
          {typeof value === 'string' || typeof value === 'number' ? (
            <Text variant="body-small">{value}</Text>
          ) : (
            value
          )}
        </dd>
      </div>
    ))}
  </dl>
);

export const Mono = ({ children }: { children: ReactNode }) => (
  <code style={{ fontFamily: 'var(--bui-font-monospace, monospace)', fontSize: '0.85em' }}>{children}</code>
);

/** A titled card. */
export const Panel = ({ title, children }: { title: string; children: ReactNode }) => (
  <Card>
    <CardHeader>
      <Text variant="title-x-small" as="h3">
        {title}
      </Text>
    </CardHeader>
    <CardBody>{children}</CardBody>
  </Card>
);

/** A titled card holding a two-column grid of form fields. */
export const Section = ({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) => (
  <Card>
    <CardHeader>
      <Flex direction="column" gap="1">
        <Text variant="title-x-small" as="h3">
          {title}
        </Text>
        {description && (
          <Text variant="body-small" color="secondary">
            {description}
          </Text>
        )}
      </Flex>
    </CardHeader>
    <CardBody>
      <Grid.Root columns={{ initial: '1', md: '2' }} gap="3">
        {children}
      </Grid.Root>
    </CardBody>
  </Card>
);

/**
 * Right-hand column of the create and edit forms: live manifest (or patch)
 * preview, Validate (server-side dry run against the XRD) and Create/Save.
 * With `unchanged`, there is nothing to send and both buttons are off.
 */
export const ManifestPanel = ({
  manifest,
  hasErrors,
  error,
  validated,
  submitting,
  onSubmit,
  createLabel,
  title = 'Manifest',
  unchanged,
}: {
  manifest: string;
  hasErrors: boolean;
  error?: Error;
  validated?: boolean;
  submitting?: 'validate' | 'create';
  onSubmit: (dryRun: boolean) => void;
  createLabel: string;
  title?: string;
  unchanged?: boolean;
}) => (
  <Flex direction="column" gap="3" style={{ position: 'sticky', top: 16 }}>
    <Card>
      <CardHeader>
        <Text variant="title-x-small" as="h3">
          {title}
        </Text>
      </CardHeader>
      <CardBody>
        <pre
          style={{
            margin: 0,
            fontSize: 12,
            lineHeight: 1.5,
            overflow: 'auto',
            maxHeight: '55vh',
          }}
        >
          {unchanged ? 'No changes yet.' : manifest}
        </pre>
      </CardBody>
    </Card>
    {hasErrors && <Alert status="warning" title="Fix the highlighted fields first" />}
    {error && <ErrorAlert error={error} />}
    {validated && (
      <Alert
        status="success"
        title="Valid"
        description={`The API server accepted ${unchanged === undefined ? 'this manifest' : 'these changes'} (dry run).`}
      />
    )}
    <Flex gap="2" justify="end">
      <Button
        variant="secondary"
        loading={submitting === 'validate'}
        isDisabled={Boolean(submitting) || unchanged}
        onPress={() => onSubmit(true)}
      >
        Validate
      </Button>
      <Button
        variant="primary"
        loading={submitting === 'create'}
        isDisabled={Boolean(submitting) || unchanged}
        onPress={() => onSubmit(false)}
      >
        {createLabel}
      </Button>
    </Flex>
  </Flex>
);
