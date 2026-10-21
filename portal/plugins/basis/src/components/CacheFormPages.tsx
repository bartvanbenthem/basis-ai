import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  Alert,
  ButtonLink,
  Container,
  Flex,
  Grid,
  Header,
  NumberField,
  Select,
  Skeleton,
  Switch,
  Text,
  TextField,
} from '@backstage/ui';
import {
  CACHE_MODES,
  cacheMaxMemory,
  type CacheMode,
  basisCacheUpdatePermission,
  basisProjectCreatePermission,
  EVICTION_POLICIES,
  type EvictionPolicy,
  type ProjectSummary,
  type Site,
} from '@internal/backstage-plugin-basis-common';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import useAsync from 'react-use/esm/useAsync';
import { stringify } from 'yaml';
import { basisApiRef } from '../api';
import { cacheRouteRef, createProjectRouteRef } from '../routes';
import {
  type CacheForm,
  defaultCacheForm,
  fromCache,
  toCacheEditPatch,
  toCacheManifest,
  toCacheSpec,
  validateCache,
} from './cacheForm';
import { ErrorAlert, ManifestPanel, Section } from './common';

const FIXED = 'Fixed after creation.';

/**
 * Every section of the cache form, shared by the create and edit pages. With
 * `original` (edit mode) the name, project and mode are read-only.
 */
const CacheFormFields = ({
  form,
  setForm,
  err,
  original,
  projects,
}: {
  form: CacheForm;
  setForm: (update: (f: CacheForm) => CacheForm) => void;
  err: (key: keyof CacheForm) => string | undefined;
  original?: CacheForm;
  projects?: ProjectSummary[];
}) => {
  const editing = Boolean(original);
  const set = <K extends keyof CacheForm>(key: K) => (value: CacheForm[K]) =>
    setForm(f => ({ ...f, [key]: value }));
  const project = projects?.find(p => p.name === form.namespace);
  const siteLocation = form.site === 'recovery' ? project?.recoveryLocation : project?.protectedLocation;
  const maxmemory = cacheMaxMemory(form.memory, form.maxMemoryPercent);
  const plainClient = form.shards === 1 && form.replicas === 0;

  return (
    <>
      <Section title="Basics">
        <TextField
          label="Name"
          isRequired
          isDisabled={editing}
          value={form.name}
          onChange={set('name')}
          description={err('name') ?? (editing ? FIXED : 'Lowercase letters, digits and "-", max 40 characters.')}
          isInvalid={Boolean(err('name'))}
        />
        {editing ? (
          <TextField label="Project" isDisabled value={form.namespace} description={FIXED} />
        ) : (
          <Select
            label="Project"
            isRequired
            value={form.namespace || null}
            onChange={k => {
              const name = String(k ?? '');
              const picked = projects?.find(p => p.name === name);
              setForm(f => ({
                ...f,
                namespace: name,
                owner: f.owner || picked?.owner || '',
                // The new project may have no recovery location.
                site: f.site === 'recovery' && !picked?.recoveryLocation ? 'protected' : f.site,
              }));
            }}
            options={(projects ?? []).map(p => ({ id: p.name, label: p.name, disabled: !p.protectedLocation }))}
            placeholder="Pick a project"
            description={err('namespace') ?? 'The cache runs in one of the project\'s locations (Site).'}
            isInvalid={Boolean(err('namespace'))}
          />
        )}
        {editing ? (
          <TextField
            label="Site"
            isDisabled
            value={`${form.site}${siteLocation ? ` (${siteLocation})` : ''}`}
            description={FIXED}
          />
        ) : (
          <Select
            label="Site"
            value={form.site}
            onChange={k => set('site')((k as Site) ?? 'protected')}
            options={[
              {
                id: 'protected',
                label: `Protected${project?.protectedLocation ? ` — ${project.protectedLocation}` : ''}`,
              },
              {
                id: 'recovery',
                label: `Recovery${project?.recoveryLocation ? ` — ${project.recoveryLocation}` : ' (the project has none)'}`,
                disabled: !project?.recoveryLocation,
              },
            ]}
            description={
              err('site') ??
              'Which of the project\'s locations runs the cache. Caches don\'t replicate between sites; create one per site for workloads in both.'
            }
            isInvalid={Boolean(err('site'))}
          />
        )}
        <TextField
          label="Owner (group)"
          value={form.owner}
          onChange={set('owner')}
          description={err('owner') ?? 'Catalog owner, e.g. team-payments.'}
          isInvalid={Boolean(err('owner'))}
        />
        {editing ? (
          <TextField label="Mode" isDisabled value={CACHE_MODES[form.mode].displayName} description={FIXED} />
        ) : (
          <Select
            label="Mode"
            value={form.mode}
            onChange={k => {
              const mode = (k as CacheMode) ?? 'exact';
              setForm(f => ({ ...defaultCacheForm(mode), name: f.name, namespace: f.namespace, owner: f.owner }));
            }}
            options={(Object.keys(CACHE_MODES) as CacheMode[]).map(m => ({ id: m, label: CACHE_MODES[m].displayName }))}
            description={`${CACHE_MODES[form.mode].description} ${FIXED}`}
          />
        )}
      </Section>

      <Section
        title="Topology"
        description="Valkey in cluster mode: shards spread the keyspace, replicas keep a shard warm when its primary fails. A cache has no persistence."
      >
        <NumberField
          label="Shards"
          minValue={1}
          maxValue={16}
          value={form.shards}
          onChange={set('shards')}
          description={err('shards') ?? 'More memory and write throughput; needs a cluster-aware client.'}
          isInvalid={Boolean(err('shards'))}
        />
        <NumberField
          label="Replicas per shard"
          minValue={0}
          maxValue={5}
          value={form.replicas}
          onChange={set('replicas')}
          description={err('replicas') ?? 'With 0 a pod restart empties its shard.'}
          isInvalid={Boolean(err('replicas'))}
        />
        <Text variant="body-small" color="secondary">
          {plainClient
            ? 'One node: clients without cluster support (e.g. LiteLLM\'s valkey-semantic cache) work too.'
            : 'Clients must support Valkey cluster mode (valkey-glide, redis-py RedisCluster, redisvl). LiteLLM\'s valkey-semantic cache needs 1 shard and 0 replicas.'}
        </Text>
      </Section>

      <Section title="Memory & eviction" description="Per Valkey pod; memory is request and limit.">
        <TextField
          label="CPU"
          value={form.cpu}
          onChange={set('cpu')}
          description={err('cpu') ?? (form.mode === 'semantic' ? 'Also caps valkey-search\'s threads.' : 'e.g. 500m or 2')}
          isInvalid={Boolean(err('cpu'))}
        />
        <TextField
          label="Memory"
          value={form.memory}
          onChange={set('memory')}
          description={err('memory') ?? 'e.g. 512Mi or 2Gi'}
          isInvalid={Boolean(err('memory'))}
        />
        <NumberField
          label="Max memory (%)"
          minValue={10}
          maxValue={90}
          value={form.maxMemoryPercent}
          onChange={set('maxMemoryPercent')}
          description={
            err('maxMemoryPercent') ??
            `maxmemory ${maxmemory ?? '-'}; the rest is for replication buffers${form.mode === 'semantic' ? ' and index building' : ''}.`
          }
          isInvalid={Boolean(err('maxMemoryPercent'))}
        />
        <Select
          label="Eviction policy"
          value={form.evictionPolicy}
          onChange={k => set('evictionPolicy')((k as EvictionPolicy) ?? 'allkeys-lru')}
          options={EVICTION_POLICIES.map(p => ({ id: p, label: p }))}
          description="What goes at maxmemory. volatile-* only evicts keys with a TTL; noeviction refuses writes."
        />
      </Section>

      <Section
        title="Monitoring"
        description="Metrics go to the project's Prometheus; the dashboard to its Grafana (the cache's Monitoring tab)."
      >
        <Switch label="Metrics (PodMonitor)" isSelected={form.monitoring} onChange={set('monitoring')} />
        <Switch
          label="Alerts (PrometheusRule)"
          isSelected={form.monitoring && form.alerts}
          isDisabled={!form.monitoring}
          onChange={set('alerts')}
        />
        <Switch label="Grafana dashboard" isSelected={form.dashboard} onChange={set('dashboard')} />
        <Text variant="body-small" color="secondary">
          Alerts: node down, cluster state, failing slots, replica link, restarts, rejected writes, connections,
          continuous eviction and a low hit ratio.
        </Text>
      </Section>
    </>
  );
};

export const CreateCachePage = () => {
  const api = useApi(basisApiRef);
  const navigate = useNavigate();
  const cacheLink = useRouteRef(cacheRouteRef);
  const createProjectLink = useRouteRef(createProjectRouteRef);
  const { allowed: canCreateProject } = usePermission({ permission: basisProjectCreatePermission });
  const [params] = useSearchParams();
  const presetMode: CacheMode = params.get('mode') === 'semantic' ? 'semantic' : 'exact';

  const { value: projects, loading: projectsLoading } = useAsync(() => api.listProjects(), [api]);
  const [form, setForm] = useState<CacheForm>(() => defaultCacheForm(presetMode));
  const selected = projects?.find(p => p.name === form.namespace);
  const siteError =
    form.site === 'recovery' && selected && !selected.recoveryLocation
      ? 'This project has no recovery location.'
      : undefined;
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState<'validate' | 'create'>();
  const [result, setResult] = useState<{ error?: Error; validated?: boolean }>({});

  // The sidebar's "New semantic cache" link changes only the query string.
  useEffect(() => {
    setForm(f => (f.mode === presetMode ? f : { ...defaultCacheForm(presetMode), name: f.name, namespace: f.namespace, owner: f.owner }));
  }, [presetMode]);

  const update = (fn: (f: CacheForm) => CacheForm) => {
    setForm(fn);
    setResult({});
  };

  const errors = useMemo(
    () => ({ ...validateCache(form), ...(siteError ? { site: siteError } : {}) }),
    [form, siteError],
  );
  const err = (key: keyof CacheForm) => (touched ? errors[key] : undefined);
  const manifest = useMemo(() => stringify(toCacheManifest(form)), [form]);

  const submit = async (dryRun: boolean) => {
    setTouched(true);
    if (Object.keys(errors).length) return;
    setSubmitting(dryRun ? 'validate' : 'create');
    setResult({});
    try {
      await api.createCache({
        name: form.name,
        namespace: form.namespace,
        owner: form.owner || undefined,
        spec: toCacheSpec(form),
        dryRun,
      });
      if (dryRun) {
        setResult({ validated: true });
      } else {
        navigate(cacheLink?.({ namespace: form.namespace, name: form.name }) ?? '/basis/caches');
      }
    } catch (e) {
      setResult({ error: e as Error });
    } finally {
      setSubmitting(undefined);
    }
  };

  return (
    <>
      <Header
        title={presetMode === 'semantic' ? 'Create semantic cache' : 'Create cache'}
        description="A Valkey cache in a project's location, for LLM responses, tool, SQL and search results"
      />
      <Container>
        <Grid.Root columns={{ initial: '1', lg: '3' }} gap="4">
          <Grid.Item colSpan={{ initial: '1', lg: '2' }}>
            <Flex direction="column" gap="4">
              {!projectsLoading && projects?.length === 0 && (
                <Alert
                  status="info"
                  title="No projects yet"
                  description="A cache lives in a project and runs in its protected location. Create a project first."
                  customActions={
                    canCreateProject && createProjectLink ? (
                      <ButtonLink href={createProjectLink()} variant="secondary" size="small">
                        Create project
                      </ButtonLink>
                    ) : undefined
                  }
                />
              )}
              <CacheFormFields form={form} setForm={update} err={err} projects={projects} />
            </Flex>
          </Grid.Item>
          <Grid.Item>
            <ManifestPanel
              manifest={manifest}
              hasErrors={touched && Object.keys(errors).length > 0}
              error={result.error}
              validated={result.validated}
              submitting={submitting}
              onSubmit={submit}
              createLabel="Create cache"
            />
          </Grid.Item>
        </Grid.Root>
      </Container>
    </>
  );
};

/** Changes a cache's topology, memory and eviction; name, project and mode are fixed. */
export const EditCachePage = () => {
  const { namespace = '', name = '' } = useParams();
  const api = useApi(basisApiRef);
  const navigate = useNavigate();
  const cacheLink = useRouteRef(cacheRouteRef);
  const { allowed: canUpdate, loading: permissionLoading } = usePermission({
    permission: basisCacheUpdatePermission,
  });

  const { value: details, error: loadError } = useAsync(() => api.getCache(namespace, name), [api, namespace, name]);
  const { value: projects } = useAsync(() => api.listProjects().catch(() => []), [api]);
  const original = useMemo(() => details && fromCache(details.resource), [details]);
  const [form, setForm] = useState<CacheForm>();
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState<'validate' | 'create'>();
  const [result, setResult] = useState<{ error?: Error; validated?: boolean }>({});

  useEffect(() => {
    if (original) setForm(original);
  }, [original]);

  const update = (fn: (f: CacheForm) => CacheForm) => {
    setForm(f => f && fn(f));
    setResult({});
  };

  const errors = useMemo(() => (form ? validateCache(form) : {}), [form]);
  const err = (key: keyof CacheForm) => (touched ? errors[key] : undefined);
  const spec = useMemo(() => (form && original ? toCacheEditPatch(original, form) : {}), [form, original]);
  const ownerChanged = Boolean(form && original && form.owner !== original.owner);
  const unchanged = Object.keys(spec).length === 0 && !ownerChanged;
  const preview = useMemo(
    () => stringify({ ...(ownerChanged ? { owner: form?.owner || null } : {}), spec }),
    [spec, ownerChanged, form],
  );
  const back = cacheLink?.({ namespace, name }) ?? '/basis/caches';

  const submit = async (dryRun: boolean) => {
    setTouched(true);
    if (Object.keys(errors).length) return;
    setSubmitting(dryRun ? 'validate' : 'create');
    setResult({});
    try {
      await api.patchCache(namespace, name, {
        spec,
        ...(ownerChanged ? { owner: form?.owner || null } : {}),
        dryRun,
      });
      if (dryRun) {
        setResult({ validated: true });
      } else {
        navigate(back);
      }
    } catch (e) {
      setResult({ error: e as Error });
    } finally {
      setSubmitting(undefined);
    }
  };

  return (
    <>
      <Header
        title={`Edit ${name}`}
        tags={[{ label: `project: ${namespace}` }]}
        breadcrumbs={[{ label: name, href: back }]}
      />
      <Container>
        {loadError && <ErrorAlert error={loadError} />}
        {!loadError && !form && <Skeleton width="100%" height={240} />}
        {!permissionLoading && !canUpdate && <Alert status="warning" title="You may not change this cache" />}
        {form && original && canUpdate && (
          <Grid.Root columns={{ initial: '1', lg: '3' }} gap="4">
            <Grid.Item colSpan={{ initial: '1', lg: '2' }}>
              <Flex direction="column" gap="4">
                <Alert
                  status="info"
                  title="How changes apply"
                  description="Max memory and the eviction policy apply live. CPU and memory roll the pods one by one, replicas first, failing primaries over before they restart; a shard without a replica loses its keys then. A shard change moves hash slots between primaries."
                />
                <CacheFormFields form={form} setForm={update} err={err} original={original} projects={projects} />
              </Flex>
            </Grid.Item>
            <Grid.Item>
              <ManifestPanel
                title="Changes"
                manifest={preview}
                unchanged={unchanged}
                hasErrors={touched && Object.keys(errors).length > 0}
                error={result.error}
                validated={result.validated}
                submitting={submitting}
                onSubmit={submit}
                createLabel="Save changes"
              />
            </Grid.Item>
          </Grid.Root>
        )}
      </Container>
    </>
  );
};
