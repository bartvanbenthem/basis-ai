import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  ButtonLink,
  CellText,
  Cell,
  type ColumnConfig,
  Container,
  Flex,
  Header,
  SearchField,
  Select,
  Table,
  Text,
  useTable,
} from '@backstage/ui';
import {
  cnpgClusterCreatePermission,
  type PostgresClusterSummary,
  PROFILES,
  VECTOR_EXTENSION,
} from '@internal/backstage-plugin-cnpg-common';
import { useMemo, useState } from 'react';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { cnpgApiRef } from '../api';
import { clusterRouteRef, createClusterRouteRef } from '../routes';
import { age, ErrorAlert, health, HealthBadge } from './common';

type Row = PostgresClusterSummary & { id: string };

const ALL = '__all__';

export const ClusterListPage = () => {
  const api = useApi(cnpgApiRef);
  const clusterLink = useRouteRef(clusterRouteRef);
  const createLink = useRouteRef(createClusterRouteRef);
  const { allowed: canCreate } = usePermission({
    permission: cnpgClusterCreatePermission,
  });
  const [namespace, setNamespace] = useState<string>(ALL);
  const [search, setSearch] = useState('');

  const { value, loading, error, retry } = useAsyncRetry(
    () => api.listClusters(),
    [api],
  );
  // PostgresCluster status changes over minutes; poll instead of a manual refresh button.
  useInterval(retry, 15_000);

  const namespaces = useMemo(
    () => Array.from(new Set((value ?? []).map(c => c.namespace))).sort(),
    [value],
  );

  const rows: Row[] = useMemo(
    () =>
      (value ?? [])
        .filter(c => namespace === ALL || c.namespace === namespace)
        .filter(
          c =>
            !search ||
            `${c.namespace}/${c.name}`.includes(search.toLowerCase()),
        )
        .map(c => ({ ...c, id: `${c.namespace}/${c.name}` })),
    [value, namespace, search],
  );

  const columns: ColumnConfig<Row>[] = [
    {
      id: 'name',
      label: 'Name',
      isRowHeader: true,
      cell: c => (
        <CellText
          title={c.name}
          description={c.owner ? `owner: ${c.owner}` : undefined}
          href={clusterLink?.({ namespace: c.namespace, name: c.name })}
        />
      ),
    },
    {
      id: 'namespace',
      label: 'Project',
      cell: c => <CellText title={c.namespace} />,
    },
    {
      id: 'status',
      label: 'Status',
      cell: c => (
        <Cell>
          <HealthBadge cluster={c} />
        </Cell>
      ),
    },
    {
      id: 'version',
      label: 'PostgreSQL',
      cell: c => (
        <CellText
          title={c.postgresVersion ? String(c.postgresVersion) : '-'}
          description={
            c.profile !== 'general'
              ? PROFILES[c.profile].displayName
              : undefined
          }
        />
      ),
    },
    {
      id: 'instances',
      label: 'Instances',
      cell: c => (
        <CellText
          title={`${c.readyInstances}/${c.instances}`}
          description={c.size ? `size ${c.size.toUpperCase()}` : undefined}
        />
      ),
    },
    {
      id: 'primary',
      label: 'Primary',
      cell: c => <CellText title={c.currentPrimary ?? '-'} />,
    },
    {
      id: 'location',
      label: 'Location',
      cell: c => (
        <CellText
          title={c.primaryLocation || '-'}
          description={
            c.recoveryLocation
              ? `+ replica in ${
                  c.primarySite === 'recovery' ? c.location : c.recoveryLocation
                }`
              : undefined
          }
        />
      ),
    },
    {
      id: 'features',
      label: 'Features',
      cell: c => (
        <CellText
          title={
            [
              c.pooler && 'pooler',
              c.backup && 'backups',
              c.extensions.includes(VECTOR_EXTENSION) && 'pgvector',
            ]
              .filter(Boolean)
              .join(', ') || '-'
          }
        />
      ),
    },
    {
      id: 'age',
      label: 'Age',
      cell: c => <CellText title={age(c.createdAt)} />,
    },
  ];

  const stats = useMemo(() => {
    const all = value ?? [];
    const count = (h: string) => all.filter(c => health(c) === h).length;
    return [
      {
        label: 'Clusters',
        value: all.length,
        hint: `${namespaces.length} project${
          namespaces.length === 1 ? '' : 's'
        }`,
      },
      {
        label: 'Healthy',
        value: count('healthy'),
        hint: 'Ready in Crossplane and CNPG',
      },
      {
        label: 'Needs attention',
        value: count('degraded') + count('progressing'),
        hint: `${count('degraded')} degraded, ${count(
          'progressing',
        )} provisioning`,
      },
      {
        label: 'Instances ready',
        value: `${all.reduce((n, c) => n + c.readyInstances, 0)}/${all.reduce(
          (n, c) => n + c.instances,
          0,
        )}`,
        hint: 'PostgreSQL pods',
      },
      {
        label: 'With backups',
        value: all.filter(c => c.backup).length,
        hint: 'Barman Cloud',
      },
    ];
  }, [value, namespaces]);

  const { tableProps } = useTable({
    mode: 'complete',
    data: rows,
    paginationOptions: { pageSize: 20 },
  });

  return (
    <>
      <Header
        title="PostgreSQL clusters"
        description="CloudNativePG clusters provisioned through the PostgresCluster API"
        customActions={
          canCreate && createLink ? (
            <ButtonLink href={createLink()} variant="primary">
              Create cluster
            </ButtonLink>
          ) : undefined
        }
      />
      <Container>
        <Flex direction="column" gap="4">
          {error && <ErrorAlert error={error} />}
          <div className="tp-stats">
            {stats.map(s => (
              <div key={s.label} className="tp-stat">
                <div className="tp-stat__label">{s.label}</div>
                <div className="tp-stat__value">{value ? s.value : '…'}</div>
                <div className="tp-stat__hint">{s.hint}</div>
              </div>
            ))}
          </div>
          <Flex gap="3" align="end">
            <Select
              label="Project"
              value={namespace}
              onChange={key => setNamespace(String(key ?? ALL))}
              options={[
                { id: ALL, label: 'All projects' },
                ...namespaces.map(n => ({ id: n, label: n })),
              ]}
            />
            <SearchField
              label="Search"
              placeholder="project/name"
              value={search}
              onChange={setSearch}
            />
          </Flex>
          <Table
            columnConfig={columns}
            {...tableProps}
            loading={loading && !value}
            emptyState={
              <Text color="secondary">
                No PostgresClusters found
                {namespace !== ALL ? ` in ${namespace}` : ''}.
              </Text>
            }
          />
        </Flex>
      </Container>
    </>
  );
};
