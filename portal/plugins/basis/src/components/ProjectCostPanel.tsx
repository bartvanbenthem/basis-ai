import { useApi } from '@backstage/frontend-plugin-api';
import { Alert, Flex, Grid, Skeleton, Text } from '@backstage/ui';
import { CLASSIFICATION_HINTS, type ProjectCost, type ProjectSummary } from '@internal/backstage-plugin-basis-common';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { basisApiRef } from '../api';
import { ErrorAlert, Fields, Panel } from './common';

const money = (value: number | undefined, currency: string) =>
  value === undefined ? '-' : new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);

const tokens = (value: number | undefined) =>
  value === undefined ? '-' : new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);

/** How much of a budget a forecast takes: a bar, amber past 80%, red past 100%. */
const BudgetBar = ({ used, budget, label }: { used?: number; budget?: number; label: string }) => {
  if (!budget || used === undefined) return null;
  const ratio = used / budget;
  let color = '#2e7d32';
  if (ratio > 1) color = '#c62828';
  else if (ratio > 0.8) color = '#ed6c02';
  return (
    <Flex direction="column" gap="1">
      <div
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{ height: 8, borderRadius: 4, background: 'rgba(128,128,128,0.25)', overflow: 'hidden' }}
      >
        <div style={{ width: `${Math.min(100, ratio * 100)}%`, height: '100%', background: color }} />
      </div>
      <Text variant="body-small" color="secondary">
        {Math.round(ratio * 100)}% of the budget
      </Text>
    </Flex>
  );
};

const Table = ({ head, rows }: { head: string[]; rows: Array<Array<string>> }) => (
  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
    <thead>
      <tr>
        {head.map((h, i) => (
          <th key={h} style={{ textAlign: i ? 'right' : 'left', padding: '4px 0', fontWeight: 500 }}>
            <Text variant="body-small" color="secondary">
              {h}
            </Text>
          </th>
        ))}
      </tr>
    </thead>
    <tbody>
      {rows.map(r => (
        <tr key={r.join('|')}>
          {r.map((c, i) => (
            <td key={i} style={{ textAlign: i ? 'right' : 'left', padding: '4px 0', fontVariantNumeric: 'tabular-nums' }}>
              <Text variant="body-small">{c}</Text>
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
);

const CostDetails = ({ cost }: { cost: ProjectCost }) => {
  if (!cost.available) {
    return <Text variant="body-small" color="secondary">{cost.reason}</Text>;
  }
  const c = cost.currency;
  return (
    <Flex direction="column" gap="4">
      <Fields
        rows={[
          ['This month (forecast)', `${money(cost.forecast, c)}${cost.budget ? ` of ${money(cost.budget, c)}` : ''}`],
          ['Last 7 days', money(cost.last7Days, c)],
          [
            'Tokens this month (forecast)',
            `${tokens(cost.tokens.forecast)}${cost.tokens.budget ? ` of ${tokens(cost.tokens.budget)}` : ''}`,
          ],
        ]}
      />
      <BudgetBar used={cost.forecast} budget={cost.budget} label="Budget used by the forecast" />
      <BudgetBar used={cost.tokens.forecast} budget={cost.tokens.budget} label="Token budget used by the forecast" />
      <Table
        head={['Per month, at the current rate', 'Site', 'Cost']}
        rows={cost.breakdown.map(b => [b.component, b.site, money(b.monthly, c)])}
      />
      {cost.tokens.byModel.length > 0 && (
        <Table
          head={['Model', 'Input tokens', 'Output tokens', 'Cost']}
          rows={cost.tokens.byModel.map(m => [m.model, tokens(m.input), tokens(m.output), money(m.monthlyCost, c)])}
        />
      )}
      <Text variant="body-small" color="secondary">
        Priced with the platform&apos;s catalog from what runs in the project&apos;s locations: CPU and memory requests,
        volumes, LoadBalancers and gateway tokens. The forecast is the last day&apos;s rate over a month.
      </Text>
    </Flex>
  );
};

/** A project's governance (classification, environment, cost center, expiry) and its cost against the budget. */
export const ProjectCostPanel = ({ project }: { project: ProjectSummary }) => {
  const api = useApi(basisApiRef);
  const { value, error, retry } = useAsyncRetry(() => api.getProjectCost(project.name), [api, project.name]);
  useInterval(retry, 60_000);
  const classification = project.classification ?? 'internal';

  return (
    <Flex direction="column" gap="4">
      {project.expired && (
        <Alert
          status="warning"
          title={`Expired on ${project.expiresAt}`}
          description="What runs keeps running, but nothing new can be created in this project. Extend its expiry date, or delete it."
        />
      )}
      <Grid.Root columns={{ initial: '1', md: '2' }} gap="4">
        <Panel title="Governance">
          <Fields
            rows={[
              ['Classification', `${classification}: ${CLASSIFICATION_HINTS[classification]}`],
              ['Environment', project.environment ?? 'production'],
              ['Cost center', project.costCenter ?? '-'],
              ['Expires', project.expiresAt ?? 'never'],
            ]}
          />
        </Panel>
        <Panel title="Cost">
          {error && !value && <ErrorAlert error={error} />}
          {!error && !value && <Skeleton width="100%" height={120} />}
          {value && <CostDetails cost={value} />}
        </Panel>
      </Grid.Root>
    </Flex>
  );
};
