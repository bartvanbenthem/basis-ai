import { mockApis, renderInTestApp } from '@backstage/frontend-test-utils';
import { permissionApiRef } from '@backstage/plugin-permission-react';
import { fireEvent, screen, within } from '@testing-library/react';
import { type MCPServer, summarizeMcpServer } from '@internal/backstage-plugin-basis-common';
import { Route, Routes } from 'react-router-dom';
import { BasisApi, basisApiRef } from '../api';
import { rootRouteRef } from '../routes';
import { McpDetailPage } from './McpDetailPage';
import { CreateMcpPage } from './McpFormPages';
import { McpListPage } from './McpListPage';

const server: MCPServer = {
  apiVersion: 'ai.cndev.nl/v1alpha1',
  kind: 'MCPServer',
  metadata: { name: 'kb', namespace: 'demo', creationTimestamp: '2026-10-23T08:00:00Z' },
  spec: {
    database: { stack: 'support-bot' },
    embeddings: { model: 'text-embedding-3-small' },
    clients: [{ name: 'claude-code' }, { name: 'bot', tools: ['search', 'recall'] }, { name: 'intern', expiresAt: '2026-01-31' }],
  },
  status: {
    activeSite: 'protected',
    expiredClients: ['intern'],
    sites: [{ site: 'protected', location: 'dc-a', active: true, replicas: 2, ready: true }],
    conditions: [{ type: 'Ready', status: 'True' }],
  },
};

const apis = (api: Partial<BasisApi>, initialRouteEntries?: string[]) =>
  ({
    apis: [
      [basisApiRef, api],
      [permissionApiRef, mockApis.permission()],
    ],
    mountedRoutes: { '/basis': rootRouteRef },
    ...(initialRouteEntries ? { initialRouteEntries } : {}),
  }) as any;

describe('MCP server pages', () => {
  it('lists servers with their database, search and clients', async () => {
    const waiting = { ...server, metadata: { ...server.metadata, name: 'wiki' }, status: { message: 'no GenAIStack nope in namespace demo' } };
    await renderInTestApp(<McpListPage />, apis({ listMcpServers: jest.fn(async () => [summarizeMcpServer(server), summarizeMcpServer(waiting)]) }));
    expect(await screen.findByText('kb')).toBeInTheDocument();
    const table = within(screen.getByRole('grid'));
    expect(table.getByText('Healthy')).toBeInTheDocument();
    expect(table.getByText('Degraded')).toBeInTheDocument();
    expect(table.getAllByText('hybrid')).toHaveLength(2);
    // Expiry comes from the status: only kb's reports one.
    expect(table.getAllByText('1 expired')).toHaveLength(1);
    expect(screen.getByText('Create MCP server')).toBeInTheDocument();
  });

  it('shows how to connect, each client\'s tools, and the keys on request', async () => {
    const getMcpKeys = jest.fn(async () => [
      { client: 'bot', key: 'bot-key' },
      { client: 'claude-code', key: 'cc-key' },
    ]);
    const api: Partial<BasisApi> = {
      getMcpServer: jest.fn(async () => ({ summary: summarizeMcpServer(server), resource: server, pods: [], events: [] })),
      getMcpKeys,
    };
    await renderInTestApp(
      <Routes>
        <Route path="/m/:namespace/:name" element={<McpDetailPage />} />
      </Routes>,
      apis(api, ['/m/demo/kb']),
    );
    expect(await screen.findByText('http://kb.demo.svc/mcp')).toBeInTheDocument();
    expect(screen.getByText(/claude mcp add --transport http kb http:\/\/localhost:8080\/mcp/)).toBeInTheDocument();
    expect(screen.getByText('search, recall')).toBeInTheDocument();
    expect(screen.getByText('expired, revoked')).toBeInTheDocument();
    expect(screen.queryByText('cc-key')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Show keys'));
    expect(await screen.findByText('cc-key')).toBeInTheDocument();
    expect(getMcpKeys).toHaveBeenCalledWith('demo', 'kb');
  });

  it('renders the create form', async () => {
    const api: Partial<BasisApi> = {
      listProjects: jest.fn(async () => []),
      listStacks: jest.fn(async () => []),
      listClusters: jest.fn(async () => []),
      listGateways: jest.fn(async () => []),
    };
    await renderInTestApp(<CreateMcpPage />, apis(api));
    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
    expect(screen.getAllByText('Embeddings model').length).toBeGreaterThan(0);
    expect(screen.getByText(/kind: MCPServer/)).toBeInTheDocument();
  });
});
