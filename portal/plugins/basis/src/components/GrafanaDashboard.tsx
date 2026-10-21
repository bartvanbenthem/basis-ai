import { ButtonLink, Card, CardBody, Flex, Text } from '@backstage/ui';
import { useState } from 'react';
import { grafanaLink, Mono, type TimeRange } from './common';

const RANGES: TimeRange[] = ['1h', '6h', '24h', '7d'];

const Notice = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <Card>
    <CardBody>
      <Flex direction="column" gap="2">
        <Text variant="title-x-small" as="h3">
          {title}
        </Text>
        {children}
      </Flex>
    </CardBody>
  </Card>
);

/**
 * The GrafanaDashboard a composition creates for a PostgresCluster (the
 * CloudNativePG dashboard) or a ValkeyCache (the Valkey cache dashboard), uid
 * in status.monitoring.dashboardUid, embedded from the project's Grafana (or
 * the one configured as basis.grafanaUrl). Both dashboards take the namespace
 * and cluster variables.
 */
export const GrafanaDashboard = ({
  grafanaUrl,
  namespace,
  name,
  uid,
  title = 'CloudNativePG',
  subject = 'cluster',
  height = 'calc(100vh - 230px)',
}: {
  grafanaUrl?: string;
  namespace: string;
  name: string;
  uid?: string;
  /** The dashboard's title prefix. */
  title?: string;
  /** What the dashboard is about, for the notices. */
  subject?: 'cluster' | 'cache';
  height?: string;
}) => {
  const [range, setRange] = useState<TimeRange>('6h');

  if (!uid) {
    return (
      <Notice title={`No dashboard for this ${subject}`}>
        <Text color="secondary">
          The Grafana dashboard is disabled (
          <Mono>spec.monitoring.grafanaDashboard.enabled</Mono>) or the
          composition hasn't created it yet.
        </Text>
      </Notice>
    );
  }

  if (!grafanaUrl) {
    return (
      <Notice title="Grafana is not connected">
        <Text color="secondary">
          The composition created dashboard <Mono>{uid}</Mono> for this {subject}.
          To show it here, set the Grafana base URL and restart the portal:
        </Text>
        <Mono>BASIS_GRAFANA_URL=https://grafana.example.com</Mono>
        <Text color="secondary">
          Grafana must allow embedding (
          <Mono>security.allow_embedding = true</Mono>) and give the browser a
          session inside the iframe, e.g. anonymous viewers or the portal's SSO.
        </Text>
      </Notice>
    );
  }

  const link = { namespace, cluster: name, range };
  const src = grafanaLink(grafanaUrl, uid, { ...link, embed: true });

  return (
    <div className="tp-grafana">
      <div className="tp-grafana__bar">
        <Text variant="body-small" color="secondary">
          {title} / {namespace} / {name}
        </Text>
        <Flex gap="2" align="center">
          <div className="tp-segmented" role="group" aria-label="Time range">
            {RANGES.map(r => (
              <button
                key={r}
                type="button"
                aria-pressed={r === range}
                onClick={() => setRange(r)}
              >
                {r}
              </button>
            ))}
          </div>
          <ButtonLink
            href={grafanaLink(grafanaUrl, uid, link)}
            target="_blank"
            rel="noopener noreferrer"
            variant="secondary"
            size="small"
          >
            Open in Grafana
          </ButtonLink>
        </Flex>
      </div>
      <iframe
        key={src}
        className="tp-grafana__frame"
        title={`Grafana dashboard ${namespace}/${name}`}
        src={src}
        style={{ height, minHeight: 520 }}
        referrerPolicy="no-referrer-when-downgrade"
      />
    </div>
  );
};
