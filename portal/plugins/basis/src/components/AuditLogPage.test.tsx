import { renderInTestApp } from '@backstage/frontend-test-utils';
import { fireEvent, screen, within } from '@testing-library/react';
import type { AuditLog, ProjectSummary } from '@internal/backstage-plugin-cnpg-common';
import { CnpgApi, cnpgApiRef } from '../api';
import { rootRouteRef } from '../routes';
import { AuditLogPage } from './AuditLogPage';

const project = (name: string) => ({ name, ready: true, locations: [] }) as unknown as ProjectSummary;

const log: AuditLog = {
  project: 'demo',
  clusters: [{ name: 'orders-db', pgauditLog: 'ddl' }, { name: 'reports-db' }],
  items: [
    {
      source: 'postgresql',
      time: '2026-10-07T09:30:00Z',
      location: 'prod-ams',
      cluster: 'orders-db',
      instance: 'orders-db-1',
      actor: 'app@orders',
      action: 'DROP TABLE',
      object: 'public.old',
      message: 'DROP TABLE old',
      type: 'DDL',
    },
    {
      source: 'kubernetes',
      time: '2026-10-07T09:20:00Z',
      location: 'prod-ams',
      cluster: 'orders-db',
      actor: 'kubelet',
      action: 'BackOff',
      object: 'Pod/orders-db-2',
      message: 'Back-off restarting failed container',
      type: 'Warning',
      count: 4,
    },
    {
      source: 'kubernetes',
      time: '2026-10-07T09:00:00Z',
      location: 'control-plane',
      action: 'ComposeResources',
      object: 'Project/demo',
      message: 'Successfully composed resources',
      type: 'Normal',
    },
  ],
};

const apis = (api: Partial<CnpgApi>, path = '/cnpg/audit') => ({
  apis: [[cnpgApiRef, api]] as const,
  mountedRoutes: { '/cnpg': rootRouteRef },
  initialRouteEntries: [path],
});

describe('AuditLogPage', () => {
  it("shows the first project's events and audit records", async () => {
    const api: Partial<CnpgApi> = {
      listProjects: jest.fn(async () => [project('demo'), project('payments')]),
      getAuditLog: jest.fn(async () => log),
    };
    await renderInTestApp(<AuditLogPage />, apis(api) as any);

    expect(await screen.findByText('DROP TABLE')).toBeInTheDocument();
    const table = within(screen.getByRole('grid'));
    expect(api.getAuditLog).toHaveBeenCalledWith('demo');
    expect(table.getByText('BackOff (×4)')).toBeInTheDocument();
    expect(table.getByText('control plane')).toBeInTheDocument();
    expect(table.getByText('orders-db-1')).toHaveAttribute('href', '/cnpg/demo/orders-db');
    expect(screen.getByText('pgaudit is off for reports-db')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'PostgreSQL' }));
    expect(table.queryByText('BackOff (×4)')).not.toBeInTheDocument();
    expect(table.getByText('DROP TABLE')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.click(screen.getByRole('button', { name: 'Warnings only' }));
    expect(table.queryByText('DROP TABLE')).not.toBeInTheDocument();
    expect(table.getByText('BackOff (×4)')).toBeInTheDocument();
  });

  it('opens the project from ?project=', async () => {
    const api: Partial<CnpgApi> = {
      listProjects: jest.fn(async () => [project('demo'), project('payments')]),
      getAuditLog: jest.fn(async (p: string) => ({ project: p, items: [], clusters: [] })),
    };
    await renderInTestApp(<AuditLogPage />, apis(api, '/cnpg/audit?project=payments') as any);
    expect(await screen.findByText('Nothing recorded for this project yet.')).toBeInTheDocument();
    expect(api.getAuditLog).toHaveBeenCalledWith('payments');
    expect(api.getAuditLog).not.toHaveBeenCalledWith('demo');
  });

  it('warns about a location it could not read', async () => {
    const api: Partial<CnpgApi> = {
      listProjects: jest.fn(async () => [project('demo')]),
      getAuditLog: jest.fn(async () => ({
        ...log,
        unreachable: [{ location: 'dr-rtm', message: 'no answer within 15s' }],
      })),
    };
    await renderInTestApp(<AuditLogPage />, apis(api) as any);
    expect(await screen.findByText("Location dr-rtm couldn't be read")).toBeInTheDocument();
  });
});
