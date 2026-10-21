import { Flex, Text } from '@backstage/ui';
import type {
  CheckStatus,
  LocationHealth,
} from '@internal/backstage-plugin-cnpg-common';
import { age, StatusDot } from './common';

export const LocationHealthBadge = ({ health }: { health?: LocationHealth }) =>
  health ? <StatusDot health={health.status} /> : <StatusDot health="progressing" />;

const MARK: Record<CheckStatus, { symbol: string; color: string; label: string }> = {
  ok: { symbol: '✓', color: 'var(--bui-fg-positive, #1f883d)', label: 'passed' },
  warning: { symbol: '!', color: 'var(--bui-fg-warning, #9a6700)', label: 'warning' },
  error: { symbol: '✕', color: 'var(--bui-fg-danger, #d1242f)', label: 'failed' },
};

/** The individual checks of a probe, one row each. */
export const HealthChecks = ({ health }: { health: LocationHealth }) => (
  <Flex direction="column" gap="2">
    {health.checks.map(c => {
      const mark = MARK[c.status];
      return (
        <Flex key={c.name} gap="2" align="start">
          <span
            aria-label={mark.label}
            style={{ color: mark.color, fontWeight: 700, width: 14, flex: 'none', textAlign: 'center' }}
          >
            {mark.symbol}
          </span>
          <Flex direction="column" gap="0">
            <Text variant="body-small" weight="bold">
              {c.name}
            </Text>
            <Text variant="body-small" color="secondary" style={{ overflowWrap: 'anywhere' }}>
              {c.message}
            </Text>
          </Flex>
        </Flex>
      );
    })}
    <Text variant="body-x-small" color="secondary">
      Checked {age(health.checkedAt)} ago from the portal backend.
    </Text>
  </Flex>
);
