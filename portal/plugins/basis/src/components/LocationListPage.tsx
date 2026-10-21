import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  ButtonLink,
  Cell,
  CellText,
  type ColumnConfig,
  Container,
  Flex,
  Header,
  Table,
  Text,
  useTable,
} from '@backstage/ui';
import {
  cnpgLocationCreatePermission,
  type LocationSummary,
} from '@internal/backstage-plugin-cnpg-common';
import { useMemo } from 'react';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { cnpgApiRef } from '../api';
import { createLocationRouteRef, locationRouteRef } from '../routes';
import { age, ErrorAlert, Mono } from './common';
import { ENVIRONMENT_LABELS, PROVIDER_LABELS } from './locationForm';
import { LocationHealthBadge } from './LocationHealth';

type Row = LocationSummary & { id: string };

export const LocationListPage = () => {
  const api = useApi(cnpgApiRef);
  const locationLink = useRouteRef(locationRouteRef);
  const createLink = useRouteRef(createLocationRouteRef);
  const { allowed: canCreate } = usePermission({ permission: cnpgLocationCreatePermission });

  const { value, loading, error, retry } = useAsyncRetry(() => api.listLocations(), [api]);
  // The backend caches health for 30s; polling faster wouldn't show anything new.
  useInterval(retry, 30_000);

  const rows: Row[] = useMemo(() => (value ?? []).map(l => ({ ...l, id: l.name })), [value]);

  const columns: ColumnConfig<Row>[] = [
    {
      id: 'name',
      label: 'Location',
      isRowHeader: true,
      cell: l => (
        <CellText
          title={l.spec.displayName || l.name}
          description={l.spec.displayName ? l.name : l.spec.description}
          href={locationLink?.({ name: l.name })}
        />
      ),
    },
    {
      id: 'environment',
      label: 'Environment',
      cell: l => (
        <CellText title={l.spec.environment ? ENVIRONMENT_LABELS[l.spec.environment] : '-'} />
      ),
    },
    {
      id: 'where',
      label: 'Provider / region',
      cell: l => (
        <CellText
          title={l.spec.provider ? PROVIDER_LABELS[l.spec.provider] : '-'}
          description={l.spec.region}
        />
      ),
    },
    {
      id: 'server',
      label: 'API server',
      cell: l => (
        <Cell>
          <Mono>{l.connection.server}</Mono>
        </Cell>
      ),
    },
    {
      id: 'version',
      label: 'Kubernetes',
      cell: l => <CellText title={l.health?.kubernetesVersion ?? '-'} />,
    },
    {
      id: 'nodes',
      label: 'Nodes',
      cell: l => (
        <CellText title={l.health?.nodes ? `${l.health.nodes.ready}/${l.health.nodes.total}` : '-'} />
      ),
    },
    {
      id: 'status',
      label: 'Status',
      cell: l => (
        <Cell>
          <Flex direction="column" gap="0">
            <LocationHealthBadge health={l.health} />
            {l.spec.schedulable === false && (
              <Text variant="body-x-small" color="secondary">
                closed for new databases
              </Text>
            )}
            {!l.providerConfig && (
              <Text variant="body-x-small" color="secondary">
                not usable by Crossplane yet
              </Text>
            )}
            {Boolean(l.projects?.length) && (
              <Text variant="body-x-small" color="secondary">
                {`${l.projects!.length} project${l.projects!.length === 1 ? '' : 's'}`}
              </Text>
            )}
          </Flex>
        </Cell>
      ),
    },
    { id: 'checked', label: 'Checked', cell: l => <CellText title={age(l.health?.checkedAt)} /> },
  ];

  const { tableProps } = useTable({
    mode: 'complete',
    data: rows,
    paginationOptions: { pageSize: 20 },
  });

  return (
    <>
      <Header
        title="Locations"
        description="Kubernetes clusters the platform can run data services in, with their health as seen from the portal"
        customActions={
          canCreate && createLink ? (
            <ButtonLink href={createLink()} variant="primary">
              Add location
            </ButtonLink>
          ) : undefined
        }
      />
      <Container>
        <Flex direction="column" gap="4">
          {error && <ErrorAlert error={error} />}
          <Table
            columnConfig={columns}
            {...tableProps}
            loading={loading && !value}
            emptyState={
              <Text color="secondary">
                No locations yet. Add one by uploading the kubeconfig of a Kubernetes cluster.
              </Text>
            }
          />
        </Flex>
      </Container>
    </>
  );
};
