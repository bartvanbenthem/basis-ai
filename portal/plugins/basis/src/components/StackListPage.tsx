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
  SearchField,
  Table,
  Text,
  useTable,
} from '@backstage/ui';
import { basisStackCreatePermission, type GenAIStackSummary } from '@internal/backstage-plugin-basis-common';
import { useMemo, useState } from 'react';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { basisApiRef } from '../api';
import { createStackRouteRef, stackRouteRef } from '../routes';
import { age, ErrorAlert, StackHealthBadge } from './common';

type Row = GenAIStackSummary & { id: string };

/** Every GenAIStack across the projects. */
export const StackListPage = () => {
  const api = useApi(basisApiRef);
  const stackLink = useRouteRef(stackRouteRef);
  const createLink = useRouteRef(createStackRouteRef);
  const { allowed: canCreate } = usePermission({ permission: basisStackCreatePermission });
  const [search, setSearch] = useState('');
  const { value, loading, error, retry } = useAsyncRetry(() => api.listStacks(), [api]);
  useInterval(retry, 15_000);

  const rows: Row[] = useMemo(
    () =>
      (value ?? [])
        .filter(s => !search || `${s.namespace}/${s.name}`.includes(search.toLowerCase()))
        .map(s => ({ ...s, id: `${s.namespace}/${s.name}` })),
    [value, search],
  );

  const columns: ColumnConfig<Row>[] = [
    {
      id: 'name',
      label: 'Name',
      isRowHeader: true,
      cell: s => (
        <CellText
          title={s.name}
          description={s.owner ? `owner: ${s.owner}` : undefined}
          href={stackLink?.({ namespace: s.namespace, name: s.name })}
        />
      ),
    },
    { id: 'namespace', label: 'Project', cell: s => <CellText title={s.namespace} /> },
    {
      id: 'status',
      label: 'Status',
      cell: s => (
        <Cell>
          <StackHealthBadge stack={s} />
        </Cell>
      ),
    },
    {
      id: 'sites',
      label: 'Sites',
      cell: s => (
        <CellText
          title={s.sites.map(x => x.location || x.site).join(' + ')}
          description={s.recovery ? `active: ${s.activeSite}` : 'single site'}
        />
      ),
    },
    {
      id: 'components',
      label: 'Components',
      cell: s => (
        <CellText
          title={['pgvector', s.cache && `cache (${s.cacheMode})`, s.gateway && 'gateway'].filter(Boolean).join(', ')}
        />
      ),
    },
    {
      id: 'models',
      label: 'Models',
      cell: s => <CellText title={s.models.length ? s.models.join(', ') : '-'} />,
    },
    { id: 'age', label: 'Age', cell: s => <CellText title={age(s.createdAt)} /> },
  ];

  const { tableProps } = useTable({ mode: 'complete', data: rows, paginationOptions: { pageSize: 20 } });

  return (
    <>
      <Header
        title="GenAI stacks"
        description="Retrieval, cache, gateway and wiring per project, provisioned through the GenAIStack API"
        customActions={
          canCreate && createLink ? (
            <ButtonLink href={createLink()} variant="primary">
              Create stack
            </ButtonLink>
          ) : undefined
        }
      />
      <Container>
        <Flex direction="column" gap="4">
          {error && <ErrorAlert error={error} />}
          <Flex gap="3" align="end">
            <SearchField label="Search" placeholder="project/name" value={search} onChange={setSearch} />
          </Flex>
          <Table
            columnConfig={columns}
            {...tableProps}
            loading={loading && !value}
            emptyState={<Text color="secondary">No GenAI stacks yet.</Text>}
          />
        </Flex>
      </Container>
    </>
  );
};
