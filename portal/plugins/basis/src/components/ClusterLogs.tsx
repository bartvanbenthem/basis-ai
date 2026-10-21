import { LogViewer } from '@backstage/core-components';
import { useApi } from '@backstage/frontend-plugin-api';
import { Card, CardBody, Flex, Select, Switch, Text } from '@backstage/ui';
import type { InstancePod } from '@internal/backstage-plugin-cnpg-common';
import { useMemo, useState } from 'react';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { cnpgApiRef } from '../api';
import { ErrorAlert } from './common';
import { formatLogs } from './logFormat';

const TAILS = [100, 500, 2000];
type View = 'parsed' | 'raw';

/**
 * The stdout of one of the cluster's pods, straight from the Kubernetes API.
 * Only the pod's current (or, with "Previous container", last crashed)
 * container: older logs need a log store such as Loki.
 */
/** Pods are picked by location and name: every location has an orders-db-1. */
const podKey = (p: InstancePod) => `${p.location}/${p.name}`;

export const ClusterLogs = ({
  namespace,
  name,
  pods,
  currentPrimary,
  primaryLocation,
}: {
  namespace: string;
  name: string;
  pods: InstancePod[];
  currentPrimary?: string;
  primaryLocation?: string;
}) => {
  const api = useApi(cnpgApiRef);
  const multiLocation = new Set(pods.map(p => p.location)).size > 1;
  const fallback =
    pods.find(
      p =>
        p.name === currentPrimary &&
        (!primaryLocation || p.location === primaryLocation),
    ) ?? pods[0];
  const [selected, setSelected] = useState<string>();
  // The selected pod can disappear (failover, scale-down): fall back to the primary.
  const current = pods.find(p => podKey(p) === selected) ?? fallback;
  const pod = current?.name;
  const location = current?.location;
  const [tailLines, setTailLines] = useState(500);
  const [previous, setPrevious] = useState(false);
  const [follow, setFollow] = useState(true);
  const [view, setView] = useState<View>('parsed');

  const state = useAsyncRetry(
    async () =>
      pod
        ? api.getPodLogs(namespace, name, {
            pod,
            location,
            tailLines,
            previous,
          })
        : undefined,
    [api, namespace, name, pod, location, tailLines, previous],
  );
  useInterval(
    state.retry,
    follow && !previous && !state.loading ? 5_000 : null,
  );

  const raw = state.value?.text ?? '';
  const text = useMemo(
    () => (view === 'parsed' ? formatLogs(raw) : raw),
    [raw, view],
  );

  if (!pod) {
    return (
      <Card>
        <CardBody>
          <Text color="secondary">This cluster has no pods yet.</Text>
        </CardBody>
      </Card>
    );
  }

  const download = () => {
    const url = URL.createObjectURL(new Blob([raw], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${multiLocation ? `${location}-` : ''}${namespace}-${pod}${
      previous ? '-previous' : ''
    }.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="tp-grafana">
      <div className="tp-grafana__bar">
        <Flex gap="3" align="end">
          <Select
            label="Pod"
            value={current ? podKey(current) : null}
            onChange={key => setSelected(String(key))}
            options={pods.map(p => ({
              id: podKey(p),
              label: multiLocation
                ? `${p.name} (${p.role}, ${p.location})`
                : `${p.name} (${p.role})`,
            }))}
          />
          <Switch
            label="Previous container"
            isSelected={previous}
            onChange={setPrevious}
          />
          <Switch
            label="Follow"
            isSelected={follow && !previous}
            isDisabled={previous}
            onChange={setFollow}
          />
        </Flex>
        <Flex gap="2" align="center">
          <div className="tp-segmented" role="group" aria-label="Lines">
            {TAILS.map(t => (
              <button
                key={t}
                type="button"
                aria-pressed={t === tailLines}
                onClick={() => setTailLines(t)}
              >
                {t} lines
              </button>
            ))}
          </div>
          <div className="tp-segmented" role="group" aria-label="Format">
            {(['parsed', 'raw'] as View[]).map(v => (
              <button
                key={v}
                type="button"
                aria-pressed={v === view}
                onClick={() => setView(v)}
              >
                {v === 'parsed' ? 'Readable' : 'JSON'}
              </button>
            ))}
          </div>
        </Flex>
      </div>
      {state.error && <ErrorAlert error={state.error} />}
      <div className="tp-logs">
        {state.value && !raw && (
          <Text color="secondary">
            No output{previous ? ' from a previous container' : ''}.
          </Text>
        )}
        {raw && (
          <LogViewer
            text={text}
            onDownloadLog={download}
            onCopyLog={() => navigator.clipboard.writeText(raw)}
          />
        )}
      </div>
    </div>
  );
};
