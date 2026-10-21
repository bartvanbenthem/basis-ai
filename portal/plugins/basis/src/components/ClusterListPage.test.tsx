import { renderInTestApp, mockApis } from '@backstage/frontend-test-utils';
import { permissionApiRef } from '@backstage/plugin-permission-react';
import { screen, within } from '@testing-library/react';
import type { PostgresClusterSummary } from '@internal/backstage-plugin-cnpg-common';
import { CnpgApi, cnpgApiRef } from '../api';
import { rootRouteRef } from '../routes';
import { ClusterListPage } from './ClusterListPage';

const cluster = (over: Partial<PostgresClusterSummary>): PostgresClusterSummary => ({
  name: 'orders-db',
  namespace: 'demo',
  postgresVersion: 17,
  profile: 'general',
  instances: 3,
  readyInstances: 3,
  phase: 'Cluster in healthy state',
  currentPrimary: 'orders-db-1',
  ready: true,
  synced: true,
  deleting: false,
  pooler: true,
  backup: false,
  extensions: [],
  location: 'ske',
  geoReplication: false,
  primaryLocation: 'ske',
  primarySite: 'protected',
  ...over,
});

describe('ClusterListPage', () => {
  it('lists clusters with their health', async () => {
    const api: Partial<CnpgApi> = {
      listClusters: jest.fn(async () => [
        cluster({}),
        cluster({
          name: 'payments-db',
          namespace: 'payments',
          ready: false,
          readyInstances: 1,
          backup: true,
          extensions: ['pg_trgm', 'vector'],
        }),
      ]),
    };
    await renderInTestApp(<ClusterListPage />, {
      apis: [
        [cnpgApiRef, api],
        [permissionApiRef, mockApis.permission()],
      ],
      mountedRoutes: { '/cnpg': rootRouteRef },
    });

    expect(await screen.findByText('orders-db')).toBeInTheDocument();
    expect(screen.getByText('payments-db')).toBeInTheDocument();
    const table = within(screen.getByRole('grid'));
    expect(table.getByText('Healthy')).toBeInTheDocument();
    expect(table.getByText('Degraded')).toBeInTheDocument();
    expect(table.getByText('1/3')).toBeInTheDocument();
    // summary tiles: 2 clusters, 1 healthy, 4/6 instances ready
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('4/6')).toBeInTheDocument();
    expect(screen.getByText('pooler')).toBeInTheDocument();
    expect(screen.getByText('pooler, backups, pgvector')).toBeInTheDocument();
    expect(screen.getByText('Create cluster')).toBeInTheDocument();
  });
});
