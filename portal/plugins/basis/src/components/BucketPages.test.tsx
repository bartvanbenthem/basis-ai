import { renderInTestApp, mockApis } from '@backstage/frontend-test-utils';
import { permissionApiRef } from '@backstage/plugin-permission-react';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ReactElement } from 'react';
import { Route, Routes } from 'react-router-dom';
import { SWRConfig } from 'swr';
import type { BucketDetails, BucketSummary } from '@internal/backstage-plugin-cnpg-common';
import { CnpgApi, cnpgApiRef } from '../api';
import { rootRouteRef } from '../routes';
import { BucketDetailPage } from './BucketDetailPage';
import { BucketListPage } from './BucketListPage';
import { bytes } from './common';

const LIVE = 'project-demo-backups77f55a62-5704-4ee2-8f85-c7bf5f2db926';
const ORPHAN = 'project-old-backups88f55a62-5704-4ee2-8f85-c7bf5f2db926';

const buckets: BucketSummary[] = [
  { name: LIVE, state: 'project', project: 'demo', usage: { objects: 14, bytes: 6_830_256 } },
  { name: ORPHAN, state: 'orphaned', formerProject: 'old', usage: { objects: 2, bytes: 2048 } },
];

const details = (summary: BucketSummary): BucketDetails => ({
  summary,
  endpoint: 'https://s3.example.com',
  folders: [{ path: 'barman/orders-db', objects: 2, bytes: 2048, cluster: 'orders-db', active: false }],
});

const apis = (api: Partial<CnpgApi>, allow = true) => ({
  apis: [
    [cnpgApiRef, api],
    [permissionApiRef, mockApis.permission({ authorize: allow ? AuthorizeResult.ALLOW : AuthorizeResult.DENY })],
  ] as const,
  mountedRoutes: { '/cnpg': rootRouteRef },
});

/** usePermission caches decisions in SWR's global cache; a fresh one per render keeps tests apart. */
const fresh = (ui: ReactElement) => <SWRConfig value={{ provider: () => new Map() }}>{ui}</SWRConfig>;

const renderDetail = (name: string, api: Partial<CnpgApi>, allow = true) =>
  renderInTestApp(
    fresh(
      <Routes>
        <Route path="/cnpg/buckets/:name" element={<BucketDetailPage />} />
        <Route path="/cnpg/buckets" element={<div>bucket list</div>} />
      </Routes>,
    ),
    { ...apis(api, allow), initialRouteEntries: [`/cnpg/buckets/${name}`] } as any,
  );

describe('bytes', () => {
  it('scales to the largest whole unit', () => {
    expect(bytes(0)).toBe('0 B');
    expect(bytes(1536)).toBe('1.5 KiB');
    expect(bytes(6_830_256)).toBe('6.5 MiB');
    expect(bytes(50 * 1024 ** 3)).toBe('50 GiB');
  });
});

describe('BucketListPage', () => {
  it('lists every bucket with its state, project and size', async () => {
    const api: Partial<CnpgApi> = { listBuckets: jest.fn(async () => ({ configured: true, items: buckets })) };
    await renderInTestApp(<BucketListPage />, apis(api) as any);

    expect(await screen.findByText(LIVE)).toBeInTheDocument();
    const table = within(screen.getByRole('grid'));
    expect(table.getByText('In use')).toBeInTheDocument();
    expect(table.getByText('Orphaned')).toBeInTheDocument();
    expect(table.getByText('demo')).toHaveAttribute('href', '/cnpg/projects/demo');
    expect(table.getByText('old (deleted)')).toBeInTheDocument();
    expect(table.getByText('6.5 MiB')).toBeInTheDocument();
    expect(table.getByText(ORPHAN).closest('a')).toHaveAttribute('href', `/cnpg/buckets/${ORPHAN}`);
  });

  it('lists the cluster\'s buckets when the object store is unreachable', async () => {
    const api: Partial<CnpgApi> = {
      listBuckets: jest.fn(async () => ({
        configured: true,
        items: [{ name: LIVE, state: 'project' as const, project: 'demo' }],
        storeError: 'Object store https://s3.example.com can\'t be read: Connection timed out after 1000 ms',
      })),
    };
    await renderInTestApp(<BucketListPage />, apis(api) as any);
    expect(await screen.findByText('Object store unreachable')).toBeInTheDocument();
    expect(screen.getByText(/Connection timed out/)).toBeInTheDocument();
    expect(within(screen.getByRole('grid')).getByText(LIVE)).toBeInTheDocument();
  });

  it('shows what the cluster knows of a bucket when the object store is unreachable', async () => {
    const api: Partial<CnpgApi> = {
      getBucket: jest.fn(async () => ({ ...details(buckets[0]), folders: [], storeError: 'ECONNREFUSED' })),
    };
    await renderDetail(LIVE, api);
    expect(await screen.findByText('Object store unreachable')).toBeInTheDocument();
    expect(screen.queryByText('Folders')).not.toBeInTheDocument();
  });

  it('says when the backend has no object store', async () => {
    const api: Partial<CnpgApi> = { listBuckets: jest.fn(async () => ({ configured: false, items: [] })) };
    await renderInTestApp(<BucketListPage />, apis(api) as any);
    expect(await screen.findByText('No object store configured')).toBeInTheDocument();
  });
});

describe('BucketDetailPage', () => {
  it('offers no delete without the permission', async () => {
    const api: Partial<CnpgApi> = { getBucket: jest.fn(async () => details(buckets[1])) };
    await renderDetail(ORPHAN, api, false);
    expect(await screen.findByText(/Created for project old/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('deletes an orphaned bucket after typing its name', async () => {
    const api: Partial<CnpgApi> = {
      getBucket: jest.fn(async () => details(buckets[1])),
      deleteBucket: jest.fn(async () => undefined),
    };
    await renderDetail(ORPHAN, api);

    expect(await screen.findByText(/Created for project old, which no longer exists/)).toBeInTheDocument();
    expect(screen.getByText('orders-db (deleted)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/no cluster can be restored from them/)).toBeInTheDocument();
    const confirm = dialog.getByRole('button', { name: 'Delete' });
    expect(confirm).toBeDisabled();
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: ORPHAN } });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.deleteBucket).toHaveBeenCalledWith(ORPHAN));
    expect(await screen.findByText('bucket list')).toBeInTheDocument();
  });

  it('offers no delete for a bucket in use', async () => {
    const api: Partial<CnpgApi> = { getBucket: jest.fn(async () => details(buckets[0])) };
    await renderDetail(LIVE, api);
    expect(await screen.findByText(/its backup bucket/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
});
