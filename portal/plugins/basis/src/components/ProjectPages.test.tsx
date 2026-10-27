import { renderInTestApp, mockApis } from '@backstage/frontend-test-utils';
import { permissionApiRef } from '@backstage/plugin-permission-react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import type {
  PostgresClusterSummary,
  ProjectSummary,
} from '@internal/backstage-plugin-basis-common';
import { BasisApi, basisApiRef } from '../api';
import { rootRouteRef } from '../routes';
import { CreateClusterPage } from './CreateClusterPage';
import { ProjectDetailPage } from './ProjectDetailPage';
import { ProjectListPage } from './ProjectListPage';

const project = (over: Partial<ProjectSummary>): ProjectSummary => ({
  name: 'demo',
  owner: 'team-demo',
  ready: true,
  synced: true,
  deleting: false,
  deletionProtection: true,
  prometheus: true,
  grafana: true,
  grafanaUrl: 'http://grafana-demo.example.com',
  locations: ['ske'],
  ...over,
});

const cluster = (namespace: string, name: string) =>
  ({ name, namespace, instances: 1, readyInstances: 1, ready: true }) as PostgresClusterSummary;

const apis = (api: Partial<BasisApi>) => ({
  apis: [
    [basisApiRef, api],
    [permissionApiRef, mockApis.permission()],
  ] as const,
  mountedRoutes: { '/basis': rootRouteRef },
});

describe('ProjectListPage', () => {
  it('lists projects with health, cluster count and Grafana', async () => {
    const api: Partial<BasisApi> = {
      listProjects: jest.fn(async () => [
        project({}),
        project({ name: 'payments', ready: false, grafanaUrl: undefined, owner: undefined }),
      ]),
      listClusters: jest.fn(async () => [cluster('demo', 'a'), cluster('demo', 'b'), cluster('other', 'c')]),
    };
    await renderInTestApp(<ProjectListPage />, apis(api) as any);

    expect(await screen.findByText('demo')).toBeInTheDocument();
    const table = within(screen.getByRole('grid'));
    expect(table.getByText('Healthy')).toBeInTheDocument();
    expect(table.getByText('Provisioning')).toBeInTheDocument();
    expect(table.getByText('2')).toBeInTheDocument();
    expect(table.getByText('Open')).toHaveAttribute('href', 'http://grafana-demo.example.com');
    expect(table.getByText('no ingress')).toBeInTheDocument();
    expect(screen.getByText('Create project')).toBeInTheDocument();
  });
});

describe('CreateClusterPage', () => {
  const base: Partial<BasisApi> = {
    getConfig: jest.fn(async () => ({ storageClasses: [] })),
    listExtensions: jest.fn(async () => []),
  };

  it('offers projects instead of free-text namespaces', async () => {
    const api: Partial<BasisApi> = {
      ...base,
      listProjects: jest.fn(async () => [project({})]),
    };
    await renderInTestApp(<CreateClusterPage />, apis(api) as any);
    expect(await screen.findByText('Project')).toBeInTheDocument();
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument();
  });

  it('points to project creation when there are no projects', async () => {
    const api: Partial<BasisApi> = {
      ...base,
      listProjects: jest.fn(async () => []),
    };
    await renderInTestApp(<CreateClusterPage />, apis(api) as any);
    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
    expect(screen.getByText('Create project')).toBeInTheDocument();
  });

  it('sends CPU and memory as spec.resources', async () => {
    const api: Partial<BasisApi> = { ...base, listProjects: jest.fn(async () => [project({})]) };
    await renderInTestApp(<CreateClusterPage />, apis(api) as any);
    const manifest = () => document.querySelector('pre')?.textContent ?? '';
    fireEvent.change(await screen.findByLabelText('Memory'), { target: { value: '8Gi' } });
    await waitFor(() => expect(manifest()).toMatch(/^ {2}resources:\n {4}cpu: 500m\n {4}memory: 8Gi$/m));
    expect(manifest()).not.toMatch(/size: [a-z]+$/m);
  });

  it('adds pgvector from the extension catalog to the bootstrap database', async () => {
    const api: Partial<BasisApi> = {
      ...base,
      listProjects: jest.fn(async () => [project({})]),
      listExtensions: jest.fn(async () => [
        { name: 'vector', displayName: 'pgvector', description: 'Vector similarity search', parameters: {} },
        { name: 'pg_trgm', displayName: 'pg_trgm', parameters: {} },
      ]),
    };
    await renderInTestApp(<CreateClusterPage />, apis(api) as any);
    const manifest = () => document.querySelector('pre')?.textContent ?? '';
    fireEvent.click(await screen.findByRole('checkbox', { name: /pgvector/ }));
    await waitFor(() => expect(manifest()).toMatch(/^ {4}extensions:\n {6}- vector$/m));
    expect(screen.getByText(/HNSW index/)).toBeInTheDocument();
  });
});

describe('ProjectDetailPage', () => {
  const noCost = jest.fn(async () => ({
    available: false, reason: 'No cost rules: the platform has no price catalog', currency: 'EUR', breakdown: [], tokens: { byModel: [] },
  }));
  const render = (api: Partial<BasisApi>) =>
    renderInTestApp(
      <Routes>
        <Route path="/p/:name" element={<ProjectDetailPage />} />
      </Routes>,
      { ...apis({ getProjectCost: noCost, ...api }), initialRouteEntries: ['/p/demo'] } as any,
    );
  const getProject = jest.fn(async () => ({
    summary: project({}),
    resource: { apiVersion: 'v1', kind: 'Project', metadata: { name: 'demo' }, spec: {} },
  }));

  it("shows the project's governance and its cost against the budget", async () => {
    const api: Partial<BasisApi> = {
      getProject: jest.fn(async () => ({
        summary: project({ classification: 'confidential', costCenter: 'CC-4711', budget: { monthly: 500 } }),
        resource: { apiVersion: 'v1', kind: 'Project', metadata: { name: 'demo' }, spec: {} },
      })),
      listClusters: jest.fn(async () => []),
      getProjectCost: jest.fn(async () => ({
        available: true, currency: 'EUR', forecast: 450, last7Days: 98, budget: 500,
        breakdown: [{ component: 'tokens', site: 'protected', monthly: 300 }],
        tokens: { forecast: 2_000_000, byModel: [{ model: 'openai/gpt-oss-120b', input: 1_500_000, output: 500_000, monthlyCost: 300 }] },
      })),
    };
    await render(api);
    expect(await screen.findByText(/confidential: Self-hosted and EU models only/)).toBeInTheDocument();
    expect(screen.getByText('CC-4711')).toBeInTheDocument();
    expect(await screen.findByText('openai/gpt-oss-120b')).toBeInTheDocument();
    // 450 of 500: over 80%.
    expect(screen.getByRole('meter', { name: 'Budget used by the forecast' })).toHaveAttribute('aria-valuenow', '90');
  });

  it("won't delete a project that still has clusters", async () => {
    const api: Partial<BasisApi> = {
      getProject,
      listClusters: jest.fn(async () => [cluster('demo', 'orders-db')]),
      deleteProject: jest.fn(),
    };
    await render(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/still has 1 PostgreSQL cluster/)).toHaveTextContent('orders-db');
    expect(dialog.queryByLabelText(/to confirm/)).not.toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('deletes an empty project once its name is typed', async () => {
    const api: Partial<BasisApi> = {
      getProject,
      listClusters: jest.fn(async () => []),
      deleteProject: jest.fn(async () => undefined),
    };
    await render(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/namespace in ske stays/)).toBeInTheDocument();
    const confirm = dialog.getByRole('button', { name: 'Delete' });
    expect(confirm).toBeDisabled();
    fireEvent.change(dialog.getByLabelText(/to confirm/), { target: { value: 'demo' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(api.deleteProject).toHaveBeenCalledWith('demo'));
  });

  it('shows per location whether it reaches the backup bucket, and why not', async () => {
    const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    const api: Partial<BasisApi> = {
      getProject: jest.fn(async () => ({
        summary: project({
          protectedLocation: 'ske',
          recoveryLocation: 'ams',
          locations: ['ske', 'ams'],
          backupBucket: {
            ready: true,
            bucket: 'demo-backups',
            reachability: [
              { location: 'ske', state: 'Reachable' as const, lastCheckTime: ago(120), lastSuccessTime: ago(118) },
              {
                location: 'ams',
                state: 'Unreachable' as const,
                lastCheckTime: ago(60),
                detail: 'PUT https://s3.example.com/demo-backups/platform-check/ams: curl: (28) Connection timed out',
              },
            ],
          },
        }),
        resource: { apiVersion: 'v1', kind: 'Project', metadata: { name: 'demo' }, spec: {} },
      })),
      listClusters: jest.fn(async () => []),
    };
    await render(api);
    expect(await screen.findByText('Backup bucket reachability')).toBeInTheDocument();
    expect(screen.getByText('ske (protected)')).toBeInTheDocument();
    expect(screen.getByText('Reachable')).toBeInTheDocument();
    expect(screen.getByText(/test object 1m ago/)).toBeInTheDocument();
    expect(screen.getByText('ams (recovery)')).toBeInTheDocument();
    expect(screen.getByText('Unreachable')).toBeInTheDocument();
    expect(screen.getByText(/it never succeeded/)).toBeInTheDocument();
    expect(screen.getByText(/Connection timed out/)).toBeInTheDocument();
  });

  it("lists the bucket's backup folders and restores a deleted cluster's into a new one", async () => {
    const api: Partial<BasisApi> = {
      getProject: jest.fn(async () => ({
        summary: project({ backupBucket: { ready: true, bucket: 'demo-backups', reachability: [] } }),
        resource: {
          apiVersion: 'v1',
          kind: 'Project',
          metadata: { name: 'demo' },
          spec: {},
          status: {
            backup: {
              servers: [
                { serverName: 'old-db', cluster: 'old-db', location: 'ske', active: false, postgresVersion: 16,
                  database: 'app', owner: 'app', firstRecoverabilityPoint: '2026-09-01T02:00:00Z' },
                { serverName: 'orders-db', cluster: 'orders-db', location: 'ske', active: true, postgresVersion: 17 },
              ],
            },
          },
        },
      })),
      listClusters: jest.fn(async () => [cluster('demo', 'orders-db')]),
      restoreCluster: jest.fn(async () => ({}) as any),
    };
    await render(api);
    expect(await screen.findByText('Kept (cluster gone)')).toBeInTheDocument();
    expect(screen.getByText('Archiving')).toBeInTheDocument();
    expect(screen.getByText('no base backup reported')).toBeInTheDocument();
    const rows = screen.getAllByRole('row');
    const oldRow = rows.find(r => within(r).queryByText('Kept (cluster gone)'))!;
    fireEvent.click(within(oldRow).getByRole('button', { name: 'Restore' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Restore old-db into a new cluster')).toBeInTheDocument();
    expect(dialog.getByLabelText(/New cluster name/)).toHaveValue('old-db-restore');
    fireEvent.click(dialog.getByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(api.restoreCluster).toHaveBeenCalledWith('demo', {
        name: 'old-db-restore',
        from: { serverName: 'old-db' },
        targetTime: undefined,
        storageSize: '10Gi',
      }),
    );
  });
});
