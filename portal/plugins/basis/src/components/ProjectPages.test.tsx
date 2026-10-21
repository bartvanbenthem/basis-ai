import { renderInTestApp, mockApis } from '@backstage/frontend-test-utils';
import { permissionApiRef } from '@backstage/plugin-permission-react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import type {
  PostgresClusterSummary,
  ProjectSummary,
} from '@internal/backstage-plugin-cnpg-common';
import { CnpgApi, cnpgApiRef } from '../api';
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

const apis = (api: Partial<CnpgApi>) => ({
  apis: [
    [cnpgApiRef, api],
    [permissionApiRef, mockApis.permission()],
  ] as const,
  mountedRoutes: { '/cnpg': rootRouteRef },
});

describe('ProjectListPage', () => {
  it('lists projects with health, cluster count and Grafana', async () => {
    const api: Partial<CnpgApi> = {
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
  const base: Partial<CnpgApi> = {
    getConfig: jest.fn(async () => ({ storageClasses: [] })),
    listSizes: jest.fn(async () => []),
    listExtensions: jest.fn(async () => []),
  };

  it('offers projects instead of free-text namespaces', async () => {
    const api: Partial<CnpgApi> = {
      ...base,
      listProjects: jest.fn(async () => [project({})]),
    };
    await renderInTestApp(<CreateClusterPage />, apis(api) as any);
    expect(await screen.findByText('Project')).toBeInTheDocument();
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument();
  });

  it('points to project creation when there are no projects', async () => {
    const api: Partial<CnpgApi> = {
      ...base,
      listProjects: jest.fn(async () => []),
    };
    await renderInTestApp(<CreateClusterPage />, apis(api) as any);
    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
    expect(screen.getByText('Create project')).toBeInTheDocument();
  });

  it("starts at the catalog's first size, with its volumes", async () => {
    const api: Partial<CnpgApi> = {
      ...base,
      listProjects: jest.fn(async () => [project({})]),
      listSizes: jest.fn(async () => [
        {
          name: 's',
          displayName: 'S',
          description: 'Small production workloads',
          resources: { requests: { cpu: '1', memory: '4Gi' } },
          parameters: { shared_buffers: '1GB' },
          storage: { size: '20Gi', walSize: '5Gi' },
        },
      ]),
    };
    await renderInTestApp(<CreateClusterPage />, apis(api) as any);
    expect(await screen.findByText(/PostgreSQL tuned: shared_buffers 1GB/)).toBeInTheDocument();
    // The manifest preview: the size instead of resources, and its volumes.
    const manifest = () => document.querySelector('pre')?.textContent ?? '';
    await waitFor(() => expect(manifest()).toMatch(/^ {2}size: s$/m));
    expect(manifest()).not.toMatch(/resources:/);
    expect(screen.queryByLabelText('CPU request')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('20Gi')).toBeInTheDocument();
  });

  it('offers custom resources without a catalog', async () => {
    const api: Partial<CnpgApi> = { ...base, listProjects: jest.fn(async () => [project({})]) };
    await renderInTestApp(<CreateClusterPage />, apis(api) as any);
    expect(await screen.findByLabelText('CPU request')).toBeInTheDocument();
    expect(screen.queryByText('Size')).not.toBeInTheDocument();
  });

  it('adds pgvector from the extension catalog to the bootstrap database', async () => {
    const api: Partial<CnpgApi> = {
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
  const render = (api: Partial<CnpgApi>) =>
    renderInTestApp(
      <Routes>
        <Route path="/p/:name" element={<ProjectDetailPage />} />
      </Routes>,
      { ...apis(api), initialRouteEntries: ['/p/demo'] } as any,
    );
  const getProject = jest.fn(async () => ({
    summary: project({}),
    resource: { apiVersion: 'v1', kind: 'Project', metadata: { name: 'demo' }, spec: {} },
  }));

  it("won't delete a project that still has clusters", async () => {
    const api: Partial<CnpgApi> = {
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
    const api: Partial<CnpgApi> = {
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
    const api: Partial<CnpgApi> = {
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
    const api: Partial<CnpgApi> = {
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
