import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import {
  Alert,
  Button,
  ButtonLink,
  Cell,
  CellText,
  type ColumnConfig,
  Container,
  Flex,
  Header,
  Link,
  SearchField,
  Select,
  Table,
  Text,
  useTable,
} from '@backstage/ui';
import {
  type AuditEntry,
  type AuditSource,
  CONTROL_PLANE,
} from '@internal/backstage-plugin-cnpg-common';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import useAsync from 'react-use/esm/useAsync';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { cnpgApiRef } from '../api';
import { clusterRouteRef, projectRouteRef } from '../routes';
import { age, ErrorAlert, Mono, StatusDot } from './common';

type Row = AuditEntry & { id: string };
type SourceFilter = 'all' | AuditSource;

const SOURCES: Array<{ id: SourceFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'kubernetes', label: 'Kubernetes' },
  { id: 'postgresql', label: 'PostgreSQL' },
];
const ALL = '__all__';

const where = (location: string) =>
  location === CONTROL_PLANE ? 'control plane' : location;

/** "2026-10-07 09:12:03" in the viewer's time zone. */
function localTime(time?: string): string {
  if (!time) return '-';
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return time;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const matches = (e: AuditEntry, query: string) =>
  [
    e.actor,
    e.action,
    e.object,
    e.message,
    e.type,
    e.instance,
    e.client,
    e.cluster,
  ].some(v => v?.toLowerCase().includes(query));

/**
 * A project's audit trail: the Kubernetes events of its namespace on the
 * control plane and in its locations, and the pgaudit records of its
 * PostgreSQL clusters. The project lives in ?project=<name> so the project
 * page can link to it.
 */
export const AuditLogPage = () => {
  const api = useApi(cnpgApiRef);
  const projectLink = useRouteRef(projectRouteRef);
  const clusterLink = useRouteRef(clusterRouteRef);
  const [params, setParams] = useSearchParams();
  const [source, setSource] = useState<SourceFilter>('all');
  const [location, setLocation] = useState(ALL);
  const [cluster, setCluster] = useState(ALL);
  const [warnings, setWarnings] = useState(false);
  const [query, setQuery] = useState('');

  const projects = useAsync(
    async () => (await api.listProjects()).map(p => p.name),
    [api],
  );
  const project = params.get('project') ?? projects.value?.[0];

  const { value, loading, error, retry } = useAsyncRetry(
    async () => (project ? api.getAuditLog(project) : undefined),
    [api, project],
  );
  useInterval(retry, project ? 30_000 : null);
  // A log of another project than the one picked is stale: hide it until the new one is in.
  const log = value?.project === project ? value : undefined;

  const all = useMemo(() => log?.items ?? [], [log]);
  const locations = useMemo(
    () => [...new Set(all.map(e => e.location))].sort(),
    [all],
  );
  const clusters = useMemo(
    () => (log?.clusters ?? []).map(c => c.name).sort(),
    [log],
  );
  const unaudited = useMemo(
    () => (log?.clusters ?? []).filter(c => !c.pgauditLog).map(c => c.name),
    [log],
  );

  const rows: Row[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter(
        e =>
          (source === 'all' || e.source === source) &&
          (location === ALL || e.location === location) &&
          (cluster === ALL || e.cluster === cluster) &&
          (!warnings || e.type === 'Warning') &&
          (!q || matches(e, q)),
      )
      .map((e, i) => ({ ...e, id: String(i) }));
  }, [all, source, location, cluster, warnings, query]);

  const stats = useMemo(() => {
    const events = all.filter(e => e.source === 'kubernetes');
    const records = all.filter(e => e.source === 'postgresql');
    const oldest = all[all.length - 1]?.time;
    const audited = (log?.clusters.length ?? 0) - unaudited.length;
    return [
      {
        label: 'Entries',
        value: all.length,
        hint: oldest ? `going back ${age(oldest)}` : 'nothing recorded',
      },
      {
        label: 'Kubernetes events',
        value: events.length,
        hint: `${events.filter(e => e.type === 'Warning').length} warnings`,
      },
      {
        label: 'PostgreSQL audit records',
        value: records.length,
        hint: `pgaudit on in ${audited} of ${
          log?.clusters.length ?? 0
        } clusters`,
      },
    ];
  }, [all, log, unaudited]);

  const columns: ColumnConfig<Row>[] = [
    {
      id: 'time',
      label: 'Time',
      cell: e => (
        <CellText
          title={localTime(e.time)}
          description={e.time ? `${age(e.time)} ago` : undefined}
        />
      ),
    },
    {
      id: 'source',
      label: 'Source',
      cell: e => (
        <Cell>
          <Flex direction="column" gap="1">
            <Text variant="body-small">
              {e.source === 'kubernetes' ? 'Kubernetes' : 'PostgreSQL'}
            </Text>
            {e.type === 'Warning' ? (
              <StatusDot health="degraded" label="Warning" />
            ) : (
              <Text variant="body-x-small" color="secondary">
                {e.type}
              </Text>
            )}
          </Flex>
        </Cell>
      ),
    },
    {
      id: 'where',
      label: 'Where',
      cell: e => (
        <Cell>
          <Flex direction="column" gap="1">
            <Text variant="body-small">{where(e.location)}</Text>
            {e.cluster && project && (
              <Link
                variant="body-x-small"
                href={clusterLink?.({ namespace: project, name: e.cluster })}
              >
                {e.instance ?? e.cluster}
              </Link>
            )}
          </Flex>
        </Cell>
      ),
    },
    {
      id: 'actor',
      label: 'Who',
      cell: e => <CellText title={e.actor ?? '-'} description={e.client} />,
    },
    {
      id: 'action',
      label: 'What',
      isRowHeader: true,
      cell: e => (
        <CellText
          title={
            e.count && e.count > 1 ? `${e.action} (×${e.count})` : e.action
          }
          description={e.object}
        />
      ),
    },
    {
      id: 'message',
      label: 'Details',
      cell: e => (
        <Cell>
          <Text
            variant="body-small"
            style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
          >
            {e.source === 'postgresql' ? <Mono>{e.message}</Mono> : e.message}
          </Text>
        </Cell>
      ),
    },
  ];

  const { tableProps } = useTable({
    mode: 'complete',
    data: rows,
    paginationOptions: { pageSize: 50 },
  });

  const download = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          rows.map(({ id: _id, ...e }) => e),
          null,
          2,
        ),
      ],
      {
        type: 'application/json',
      },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-${project}-${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/:/g, '')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const option = (label: string) => (id: string) => ({
    id,
    label: id === ALL ? label : id,
  });

  return (
    <>
      <Header
        title="Audit logs"
        description="Kubernetes events of a project's namespace, on the control plane and in its locations, and the pgaudit records of its PostgreSQL clusters"
        customActions={
          <Flex gap="3" align="center">
            {project && projectLink && (
              <ButtonLink
                href={projectLink({ name: project })}
                variant="secondary"
              >
                Project {project}
              </ButtonLink>
            )}
            <Button
              variant="secondary"
              isDisabled={!rows.length}
              onPress={download}
            >
              Export JSON
            </Button>
          </Flex>
        }
      />
      <Container>
        <Flex direction="column" gap="4">
          {projects.error && <ErrorAlert error={projects.error} />}
          {error && <ErrorAlert error={error} />}
          {projects.value?.length === 0 && (
            <Text color="secondary">
              No projects yet: audit logs are kept per project.
            </Text>
          )}
          {log?.unreachable?.map(u => (
            <Alert
              key={u.location}
              status="warning"
              title={`${
                u.location === CONTROL_PLANE
                  ? 'The control plane'
                  : `Location ${u.location}`
              } couldn't be read`}
              description={`Its entries are missing: ${u.message}`}
            />
          ))}
          {unaudited.length > 0 && (
            <Alert
              status="info"
              title={`pgaudit is off for ${unaudited.join(', ')}`}
              description={
                <>
                  Switch on <strong>Audit logging (pgaudit)</strong> in a
                  cluster's Edit form (it sets{' '}
                  <Mono>spec.postgresql.parameters["pgaudit.log"]</Mono>) to
                  record its SQL statements.
                </>
              }
            />
          )}
          <div className="tp-stats">
            {stats.map(s => (
              <div key={s.label} className="tp-stat">
                <div className="tp-stat__label">{s.label}</div>
                <div className="tp-stat__value">{log ? s.value : '…'}</div>
                <div className="tp-stat__hint">{log ? s.hint : ''}</div>
              </div>
            ))}
          </div>
          <Flex gap="3" align="end" style={{ flexWrap: 'wrap' }}>
            <Select
              label="Project"
              value={project ?? null}
              onChange={key => {
                const next = new URLSearchParams(params);
                next.set('project', String(key));
                setParams(next, { replace: true });
                setCluster(ALL);
                setLocation(ALL);
              }}
              options={(projects.value ?? (project ? [project] : [])).map(
                p => ({ id: p, label: p }),
              )}
            />
            <Select
              label="Location"
              value={location}
              onChange={key => setLocation(String(key ?? ALL))}
              options={[ALL, ...locations].map(id => ({
                id,
                label: id === ALL ? 'All locations' : where(id),
              }))}
            />
            <Select
              label="Cluster"
              value={cluster}
              onChange={key => setCluster(String(key ?? ALL))}
              options={[ALL, ...clusters].map(option('All clusters'))}
            />
            <div className="tp-segmented" role="group" aria-label="Source">
              {SOURCES.map(s => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={s.id === source}
                  onClick={() => setSource(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="tp-segmented" role="group" aria-label="Severity">
              <button
                type="button"
                aria-pressed={warnings}
                onClick={() => setWarnings(!warnings)}
              >
                Warnings only
              </button>
            </div>
            <SearchField
              aria-label="Search"
              placeholder="Search"
              value={query}
              onChange={setQuery}
            />
          </Flex>
          <Table
            columnConfig={columns}
            {...tableProps}
            loading={(loading || projects.loading) && !log}
            emptyState={
              <Text color="secondary">
                {all.length
                  ? 'No entries match the filters.'
                  : 'Nothing recorded for this project yet.'}
              </Text>
            }
          />
          <Text variant="body-x-small" color="secondary">
            Kubernetes keeps events for about an hour; PostgreSQL audit records
            come from the current log of each instance (the last 5000 lines), so
            a restarted instance starts over. Keep a longer history with a log
            store such as Loki.
          </Text>
        </Flex>
      </Container>
    </>
  );
};
