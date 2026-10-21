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
  Link,
  Table,
  Text,
  useTable,
} from '@backstage/ui';
import {
  cnpgProjectCreatePermission,
  type ProjectSummary,
} from '@internal/backstage-plugin-cnpg-common';
import { useMemo } from 'react';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { cnpgApiRef } from '../api';
import { createProjectRouteRef, projectRouteRef } from '../routes';
import { age, ErrorAlert, ProjectHealthBadge } from './common';

type Row = ProjectSummary & { id: string; clusters: number };

export const ProjectListPage = () => {
  const api = useApi(cnpgApiRef);
  const projectLink = useRouteRef(projectRouteRef);
  const createLink = useRouteRef(createProjectRouteRef);
  const { allowed: canCreate } = usePermission({ permission: cnpgProjectCreatePermission });

  const { value, loading, error, retry } = useAsyncRetry(
    async () => {
      const [projects, clusters] = await Promise.all([api.listProjects(), api.listClusters()]);
      return { projects, clusters };
    },
    [api],
  );
  // A new project's Prometheus/Grafana take a minute or two.
  useInterval(retry, 15_000);

  const rows: Row[] = useMemo(
    () =>
      (value?.projects ?? []).map(p => ({
        ...p,
        id: p.name,
        clusters: (value?.clusters ?? []).filter(c => c.namespace === p.name).length,
      })),
    [value],
  );

  const columns: ColumnConfig<Row>[] = [
    {
      id: 'name',
      label: 'Project',
      isRowHeader: true,
      cell: p => (
        <CellText
          title={p.name}
          description={p.description}
          href={projectLink?.({ name: p.name })}
        />
      ),
    },
    { id: 'owner', label: 'Owner', cell: p => <CellText title={p.owner ?? '-'} /> },
    {
      id: 'status',
      label: 'Status',
      cell: p => (
        <Cell>
          <ProjectHealthBadge project={p} />
        </Cell>
      ),
    },
    { id: 'clusters', label: 'Clusters', cell: p => <CellText title={String(p.clusters)} /> },
    {
      id: 'grafana',
      label: 'Grafana',
      cell: p => (
        <Cell>
          {p.grafanaUrl ? (
            <Link href={p.grafanaUrl} target="_blank" rel="noopener noreferrer">
              Open
            </Link>
          ) : (
            <Text variant="body-small" color="secondary">
              {p.grafana ? 'no ingress' : 'disabled'}
            </Text>
          )}
        </Cell>
      ),
    },
    { id: 'age', label: 'Age', cell: p => <CellText title={age(p.createdAt)} /> },
  ];

  const { tableProps } = useTable({
    mode: 'complete',
    data: rows,
    paginationOptions: { pageSize: 20 },
  });

  return (
    <>
      <Header
        title="Projects"
        description="Projects with their own Prometheus and Grafana, provisioned through the Project API"
        customActions={
          canCreate && createLink ? (
            <ButtonLink href={createLink()} variant="primary">
              Create project
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
                No projects yet. A project comes with its own Prometheus and Grafana;
                PostgreSQL clusters are created inside one.
              </Text>
            }
          />
        </Flex>
      </Container>
    </>
  );
};
