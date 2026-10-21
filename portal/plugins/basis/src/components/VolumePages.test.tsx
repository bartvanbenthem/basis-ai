import { renderInTestApp, mockApis } from '@backstage/frontend-test-utils';
import { permissionApiRef } from '@backstage/plugin-permission-react';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ReactElement } from 'react';
import { SWRConfig } from 'swr';
import type { VolumeSummary } from '@internal/backstage-plugin-cnpg-common';
import { CnpgApi, cnpgApiRef } from '../api';
import { rootRouteRef } from '../routes';
import { VolumeListPage } from './VolumeListPage';

const live: VolumeSummary = {
  location: 'prod-ams',
  project: 'demo',
  claim: 'orders-db-1',
  volume: 'pv-1',
  state: 'in-use',
  cluster: 'orders-db',
  instance: 'orders-db-1',
  role: 'data',
  phase: 'Bound',
  capacity: '20Gi',
  usedBytes: 5 * 1024 ** 3,
  capacityBytes: 20 * 1024 ** 3,
  storageClass: 'fast',
  reclaimPolicy: 'Delete',
  pod: 'orders-db-1',
  node: 'node-a',
};

const orphan: VolumeSummary = {
  location: 'prod-ams',
  project: 'demo',
  claim: 'gone-db-1',
  volume: 'pv-2',
  state: 'orphaned',
  cluster: 'gone-db',
  instance: 'gone-db-1',
  role: 'data',
  phase: 'Bound',
  capacity: '10Gi',
  reclaimPolicy: 'Retain',
};

const apis = (api: Partial<CnpgApi>, allow = true) => ({
  apis: [
    [cnpgApiRef, api],
    [permissionApiRef, mockApis.permission({ authorize: allow ? AuthorizeResult.ALLOW : AuthorizeResult.DENY })],
  ] as const,
  mountedRoutes: { '/cnpg': rootRouteRef },
});

/** usePermission caches decisions in SWR's global cache; a fresh one per render keeps tests apart. */
const fresh = (ui: ReactElement) => <SWRConfig value={{ provider: () => new Map() }}>{ui}</SWRConfig>;

describe('VolumeListPage', () => {
  it('lists the volumes with their state, cluster and usage', async () => {
    const api: Partial<CnpgApi> = { listVolumes: jest.fn(async () => ({ items: [live, orphan] })) };
    await renderInTestApp(fresh(<VolumeListPage />), apis(api) as any);

    expect(await screen.findByText('gone-db-1')).toBeInTheDocument();
    const table = within(screen.getByRole('grid'));
    expect(table.getByText('In use')).toBeInTheDocument();
    expect(table.getByText('Orphaned')).toBeInTheDocument();
    expect(table.getByText('orders-db')).toHaveAttribute('href', '/cnpg/demo/orders-db');
    expect(table.getByText('gone-db (deleted)')).toBeInTheDocument();
    expect(table.getByText('5.0 GiB (25%)')).toBeInTheDocument();
    expect(table.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
  });

  it('deletes an orphaned volume after typing its claim name', async () => {
    const api: Partial<CnpgApi> = {
      listVolumes: jest.fn(async () => ({ items: [live, orphan] })),
      deleteVolume: jest.fn(async () => undefined),
    };
    await renderInTestApp(fresh(<VolumeListPage />), apis(api) as any);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/switches it to Delete/)).toBeInTheDocument();
    const confirm = dialog.getByRole('button', { name: 'Delete' });
    expect(confirm).toBeDisabled();
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: 'gone-db-1' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.deleteVolume).toHaveBeenCalledWith(orphan));
    await waitFor(() => expect(api.listVolumes).toHaveBeenCalledTimes(2));
  });

  it('offers no delete without the permission', async () => {
    const api: Partial<CnpgApi> = { listVolumes: jest.fn(async () => ({ items: [orphan] })) };
    await renderInTestApp(fresh(<VolumeListPage />), apis(api, false) as any);
    expect(await screen.findByText('gone-db (deleted)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('warns about an unreachable location', async () => {
    const api: Partial<CnpgApi> = {
      listVolumes: jest.fn(async () => ({ items: [], unreachable: [{ location: 'dr-rtm', message: 'timeout' }] })),
    };
    await renderInTestApp(fresh(<VolumeListPage />), apis(api) as any);
    expect(await screen.findByText('Location dr-rtm unreachable')).toBeInTheDocument();
  });
});
