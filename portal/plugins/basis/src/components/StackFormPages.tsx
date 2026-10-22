import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  Alert,
  Button,
  ButtonLink,
  Checkbox,
  CheckboxGroup,
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
  type CacheMode,
  type ClusterExtension,
  type ClusterSize,
  basisProjectCreatePermission,
  type ModelGatewaySummary,
  basisStackUpdatePermission,
  type ProjectSummary,
  sizeLabel,
} from '@internal/backstage-plugin-basis-common';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useAsync from 'react-use/esm/useAsync';
import { stringify } from 'yaml';
import { basisApiRef } from '../api';
import { createProjectRouteRef, stackRouteRef } from '../routes';
import { ErrorAlert, ManifestPanel, Section } from './common';
import { auditOptions } from './form';
import { ExposeFields } from './ExposeFields';
import { ModelFields } from './ModelFields';
import {
  defaultStackForm,
  emptyModel,
  fromStack,
  hasErrors,
  type StackErrors,
  type StackForm,
  toStackEditPatch,
  toStackManifest,
  stackProviderKeys,
  toStackSpec,
  validateStack,
} from './stackForm';

const FIXED = 'Fixed after creation.';
const OWN_GATEWAY = '__own__';
const DEFAULT_SIZE = '__default__';

/** Every section of the stack form, shared by the create and edit pages. */
const StackFormFields = ({
  form,
  setForm,
  errors,
  touched,
  editing,
  projects,
  gateways,
  sizes,
  extensions,
}: {
  form: StackForm;
  setForm: (update: (f: StackForm) => StackForm) => void;
  errors: StackErrors;
  touched: boolean;
  editing?: boolean;
  projects?: ProjectSummary[];
  /** The project's ModelGateways that aren't another stack's own, to share. */
  gateways: ModelGatewaySummary[];
  sizes: ClusterSize[];
  extensions: ClusterExtension[];
}) => {
  const set = <K extends keyof StackForm>(key: K) => (value: StackForm[K]) => setForm(f => ({ ...f, [key]: value }));
  const err = (key: Exclude<keyof StackErrors, 'modelRows'>) => (touched ? errors[key] : undefined);
  const project = projects?.find(p => p.name === form.namespace);
  const recoveryLocation = project?.recoveryLocation;
  const shareable = gateways.filter(g => g.namespace === form.namespace && !g.stack);
  let gatewayHint: string | undefined;
  if (form.gatewayRef) {
    gatewayHint = `The stack calls ${form.gatewayRef} as client ${form.gatewayClient || form.name || '<name>'}: add that client to the gateway's clients.`;
  } else if (!shareable.length) {
    gatewayHint = 'No shared gateways in this project yet; create one under Building blocks → Model gateways.';
  }
  // The catalog, plus what the stack already lists.
  const extensionNames = [...new Set([...extensions.map(e => e.name), ...form.extensions])];

  return (
    <>
      <Section title="Stack" description="One object for the platform side of a generative AI service: retrieval, cache, gateway and the wiring between them.">
        <TextField
          label="Name"
          isRequired
          isDisabled={editing}
          value={form.name}
          onChange={set('name')}
          description={err('name') ?? (editing ? FIXED : 'Lowercase letters, digits and "-", max 28 characters.')}
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
                recovery: f.recovery && Boolean(picked?.recoveryLocation),
              }));
            }}
            options={(projects ?? []).map(p => ({ id: p.name, label: p.name, disabled: !p.protectedLocation }))}
            placeholder="Pick a project"
            description={err('namespace') ?? (project?.protectedLocation ? `Runs in ${project.protectedLocation} (protected site).` : undefined)}
            isInvalid={Boolean(err('namespace'))}
          />
        )}
        <TextField
          label="Owner (group)"
          value={form.owner}
          onChange={set('owner')}
          description={err('owner') ?? 'Catalog owner, e.g. team-payments.'}
          isInvalid={Boolean(err('owner'))}
        />
      </Section>

      <Section
        title="Sites"
        description="The protected site serves. With recovery, the recovery site is a warm standby: a database replica, a small cold cache and a minimal gateway. Switch site on the stack's page makes it the active site."
      >
        <Switch
          label={recoveryLocation ? `Warm standby in ${recoveryLocation} (recovery site)` : 'Warm standby in the recovery site'}
          isSelected={form.recovery}
          isDisabled={!recoveryLocation && !form.recovery}
          onChange={set('recovery')}
        />
        <Text variant="body-small" color="secondary">
          {recoveryLocation
            ? 'Needs the project\'s backup bucket: the replica is fed from the database\'s backups.'
            : 'The project has no recovery location.'}
        </Text>
        {form.recovery && (
          <>
            <TextField
              label="Standby cache memory"
              value={form.recoveryCacheMemory}
              onChange={set('recoveryCacheMemory')}
              description={err('recoveryCacheMemory') ?? 'It gets the full size once active.'}
              isInvalid={Boolean(err('recoveryCacheMemory'))}
            />
            <NumberField
              label="Standby gateway replicas"
              minValue={0}
              maxValue={10}
              value={form.recoveryGatewayReplicas}
              onChange={set('recoveryGatewayReplicas')}
            />
          </>
        )}
      </Section>

      <Section title="Retrieval" description="The RAG database: PostgreSQL 18 with the vector profile (pgvector, VectorChord, pg_search), PostgresCluster <name>-db.">
        <Select
          label="Size"
          value={form.size || DEFAULT_SIZE}
          onChange={k => set('size')(k === DEFAULT_SIZE ? '' : String(k))}
          options={[{ id: DEFAULT_SIZE, label: 'Default (0.5 vCPU, 1Gi)' }, ...sizes.map(s => ({ id: s.name, label: sizeLabel(s) }))]}
        />
        <NumberField label="Instances" minValue={1} maxValue={9} value={form.instances} onChange={set('instances')} />
        <TextField
          label="Storage"
          value={form.storageSize}
          onChange={set('storageSize')}
          description={err('storageSize') ?? 'Can grow later, not shrink.'}
          isInvalid={Boolean(err('storageSize'))}
        />
        <Switch
          label="Backups to the project's bucket"
          isSelected={form.backup || form.recovery}
          isDisabled={form.recovery}
          onChange={set('backup')}
        />
        <CheckboxGroup
          label="Extensions"
          value={form.extensions}
          onChange={v => set('extensions')(extensionNames.filter(n => v.includes(n)))}
        >
          {extensionNames.map(n => (
            <Checkbox key={n} value={n}>
              {extensions.find(e => e.name === n)?.displayName ?? n}
            </Checkbox>
          ))}
        </CheckboxGroup>
        <Switch
          label="Audit logging (pgaudit)"
          isSelected={form.auditEnabled}
          onChange={set('auditEnabled')}
        />
        {form.auditEnabled && (
          <Select
            label="What to record"
            value={form.auditLog}
            onChange={key => set('auditLog')(String(key))}
            options={auditOptions(form.auditLog)}
            description={
              err('auditLog') ??
              "pgaudit records who ran which statement, on which object; the project's Audit logs page shows the records."
            }
            isInvalid={Boolean(err('auditLog'))}
          />
        )}
        {editing && (
          <Text variant="body-small" color="secondary">
            Turning audit logging on or off loads or unloads the pgaudit library: the database's instances restart one by
            one, the primary last (switchover).
          </Text>
        )}
        <ExposeFields
          label="Expose the database through a LoadBalancer"
          hostname={false}
          value={form.dbExpose}
          onChange={set('dbExpose')}
          errors={touched ? { sourceRanges: errors.dbExposeSourceRanges } : {}}
          hint="For ingestion jobs and tools outside the location: only these reach port 5432 on <name>-db-external (TLS; CA in Secret <name>-db-ca). Apps in the location keep DATABASE_URL."
        />
      </Section>

      <Section title="Cache" description="A Valkey cache per site for the app's exact or semantic lookups (one node, so any client works). Valkey <name>-cache.">
        <Switch label="Cache" isSelected={form.cacheEnabled} onChange={set('cacheEnabled')} />
        {form.cacheEnabled && (
          <>
            <Select
              label="Mode"
              value={form.cacheMode}
              onChange={k => set('cacheMode')((k as CacheMode) ?? 'semantic')}
              options={(Object.keys(CACHE_MODES) as CacheMode[]).map(m => ({ id: m, label: CACHE_MODES[m].displayName }))}
              description={CACHE_MODES[form.cacheMode].description}
            />
            <TextField
              label="Memory"
              value={form.cacheMemory}
              onChange={set('cacheMemory')}
              description={err('cacheMemory') ?? 'Of the active site\'s cache pod.'}
              isInvalid={Boolean(err('cacheMemory'))}
            />
          </>
        )}
      </Section>

      <Section
        title="Gateway"
        description="A model gateway (Agent Router) per site: one internal, OpenAI-compatible endpoint that routes on the request's model. Provider keys stay in the platform; apps use the stack's key from the connection Secret. The stack's own gateway, or one shared with other stacks and agents."
      >
        <Switch label="Gateway" isSelected={form.gatewayEnabled} onChange={set('gatewayEnabled')} />
        {form.gatewayEnabled && (
          <Select
            label="Which gateway"
            value={form.gatewayRef || OWN_GATEWAY}
            onChange={k => set('gatewayRef')(k === OWN_GATEWAY ? '' : String(k ?? ''))}
            options={[
              { id: OWN_GATEWAY, label: `Its own (${form.name || '<name>'}-gateway), with the models below` },
              ...shareable.map(g => ({ id: g.name, label: `Shared: ${g.name} (${g.models.length} model${g.models.length === 1 ? '' : 's'})` })),
              // An existing ref to a gateway that's gone (or in another state) stays selectable.
              ...(form.gatewayRef && !shareable.some(g => g.name === form.gatewayRef)
                ? [{ id: form.gatewayRef, label: `Shared: ${form.gatewayRef}` }]
                : []),
            ]}
            description={gatewayHint}
          />
        )}
        {form.gatewayEnabled && form.gatewayRef && (
          <TextField
            label="Client name in the gateway"
            value={form.gatewayClient}
            onChange={set('gatewayClient')}
            placeholder={form.name || '<name>'}
            description={err('gatewayClient') ?? 'Empty for the stack\'s name.'}
            isInvalid={Boolean(err('gatewayClient'))}
          />
        )}
        {form.gatewayEnabled && !form.gatewayRef && (
          <NumberField
            label="Replicas (active site)"
            minValue={1}
            maxValue={10}
            value={form.gatewayReplicas}
            onChange={set('gatewayReplicas')}
          />
        )}
        {form.gatewayEnabled && !form.gatewayRef && (
          <TextField
            label="Monthly token cap"
            value={form.gatewayMonthlyTokens}
            onChange={set('gatewayMonthlyTokens')}
            placeholder="none"
            description={
              err('gatewayMonthlyTokens') ??
              'Input and output tokens per calendar month, per site; past it the gateway answers 429.'
            }
            isInvalid={Boolean(err('gatewayMonthlyTokens'))}
          />
        )}
        {form.gatewayEnabled && !form.gatewayRef && (
          <ExposeFields
            label="Expose the gateway over HTTPS"
            value={form.gatewayExpose}
            onChange={set('gatewayExpose')}
            errors={touched ? { hostname: errors.gatewayExposeHostname, sourceRanges: errors.gatewayExposeSourceRanges } : {}}
            hint="For agents and tools outside the location, with the stack's key; 0.0.0.0/0 for everyone. Apps in the location keep OPENAI_BASE_URL."
          />
        )}
      </Section>

      {form.gatewayEnabled && !form.gatewayRef && (
        <Flex direction="column" gap="3">
          <Text variant="title-x-small" as="h3">
            Models
          </Text>
          {form.models.map((m, i) => (
            <ModelFields
              key={i}
              model={m}
              index={i}
              namespace={form.namespace}
              owner={form.name}
              error={touched ? errors.modelRows?.[i] : undefined}
              onChange={model => setForm(f => ({ ...f, models: f.models.map((x, j) => (j === i ? model : x)) }))}
              onRemove={() => setForm(f => ({ ...f, models: f.models.filter((_, j) => j !== i) }))}
            />
          ))}
          <Flex>
            <Button variant="secondary" onPress={() => setForm(f => ({ ...f, models: [...f.models, emptyModel()] }))}>
              Add model
            </Button>
          </Flex>
        </Flex>
      )}
    </>
  );
};

function useCatalogs() {
  const api = useApi(basisApiRef);
  const { value: sizes } = useAsync(() => api.listSizes().catch(() => []), [api]);
  const { value: extensions } = useAsync(() => api.listExtensions().catch(() => []), [api]);
  const { value: gateways } = useAsync(() => api.listGateways().catch(() => []), [api]);
  return { sizes: sizes ?? [], extensions: extensions ?? [], gateways: gateways ?? [] };
}

export const CreateStackPage = () => {
  const api = useApi(basisApiRef);
  const navigate = useNavigate();
  const stackLink = useRouteRef(stackRouteRef);
  const createProjectLink = useRouteRef(createProjectRouteRef);
  const { allowed: canCreateProject } = usePermission({ permission: basisProjectCreatePermission });
  const { value: projects, loading: projectsLoading } = useAsync(() => api.listProjects(), [api]);
  const { sizes, extensions, gateways } = useCatalogs();
  const [form, setForm] = useState<StackForm>(defaultStackForm);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState<'validate' | 'create'>();
  const [result, setResult] = useState<{ error?: Error; validated?: boolean }>({});

  const update = (fn: (f: StackForm) => StackForm) => {
    setForm(fn);
    setResult({});
  };
  const errors = useMemo(() => validateStack(form), [form]);
  const manifest = useMemo(() => stringify(toStackManifest(form)), [form]);

  const submit = async (dryRun: boolean) => {
    setTouched(true);
    if (hasErrors(errors)) return;
    setSubmitting(dryRun ? 'validate' : 'create');
    setResult({});
    try {
      await api.createStack({
        name: form.name,
        namespace: form.namespace,
        owner: form.owner || undefined,
        spec: toStackSpec(form),
        providerKeys: stackProviderKeys(form),
        dryRun,
      });
      if (dryRun) setResult({ validated: true });
      else navigate(stackLink?.({ namespace: form.namespace, name: form.name }) ?? '/basis/stacks');
    } catch (e) {
      setResult({ error: e as Error });
    } finally {
      setSubmitting(undefined);
    }
  };

  return (
    <>
      <Header
        title="Create GenAI stack"
        description="Retrieval (pgvector), cache (Valkey), a model gateway and their wiring in a project, with an optional warm standby"
      />
      <Container>
        <Grid.Root columns={{ initial: '1', lg: '3' }} gap="4">
          <Grid.Item colSpan={{ initial: '1', lg: '2' }}>
            <Flex direction="column" gap="4">
              {!projectsLoading && projects?.length === 0 && (
                <Alert
                  status="info"
                  title="No projects yet"
                  description="A stack lives in a project and runs in its locations. Create a project first."
                  customActions={
                    canCreateProject && createProjectLink ? (
                      <ButtonLink href={createProjectLink()} variant="secondary" size="small">
                        Create project
                      </ButtonLink>
                    ) : undefined
                  }
                />
              )}
              <StackFormFields
                form={form}
                setForm={update}
                errors={errors}
                touched={touched}
                projects={projects}
                gateways={gateways}
                sizes={sizes}
                extensions={extensions}
              />
            </Flex>
          </Grid.Item>
          <Grid.Item>
            <ManifestPanel
              manifest={manifest}
              hasErrors={touched && hasErrors(errors)}
              error={result.error}
              validated={result.validated}
              submitting={submitting}
              onSubmit={submit}
              createLabel="Create stack"
            />
          </Grid.Item>
        </Grid.Root>
      </Container>
    </>
  );
};

/** Changes a stack: sites, sizes, cache, gateway and its models. Name and project are fixed. */
export const EditStackPage = () => {
  const { namespace = '', name = '' } = useParams();
  const api = useApi(basisApiRef);
  const navigate = useNavigate();
  const stackLink = useRouteRef(stackRouteRef);
  const { allowed: canUpdate, loading: permissionLoading } = usePermission({ permission: basisStackUpdatePermission });
  const { value: stack, error: loadError } = useAsync(() => api.getStack(namespace, name), [api, namespace, name]);
  const { value: projects } = useAsync(() => api.listProjects().catch(() => []), [api]);
  const { sizes, extensions, gateways } = useCatalogs();
  const original = useMemo(() => stack && fromStack(stack.resource), [stack]);
  const [form, setForm] = useState<StackForm>();
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState<'validate' | 'create'>();
  const [result, setResult] = useState<{ error?: Error; validated?: boolean }>({});

  useEffect(() => {
    if (original) setForm(original);
  }, [original]);

  const update = (fn: (f: StackForm) => StackForm) => {
    setForm(f => f && fn(f));
    setResult({});
  };
  const errors = useMemo(() => (form ? validateStack(form) : {}), [form]);
  const spec = useMemo(() => (form && original ? toStackEditPatch(original, form) : {}), [form, original]);
  const ownerChanged = Boolean(form && original && form.owner !== original.owner);
  const unchanged = Object.keys(spec).length === 0 && !ownerChanged;
  const preview = useMemo(
    () => stringify({ ...(ownerChanged ? { owner: form?.owner || null } : {}), spec }),
    [spec, ownerChanged, form],
  );
  const back = stackLink?.({ namespace, name }) ?? '/basis/stacks';

  const submit = async (dryRun: boolean) => {
    setTouched(true);
    if (hasErrors(errors)) return;
    setSubmitting(dryRun ? 'validate' : 'create');
    setResult({});
    try {
      await api.patchStack(namespace, name, {
        spec,
        providerKeys: form ? stackProviderKeys(form) : undefined,
        ...(ownerChanged ? { owner: form?.owner || null } : {}),
        dryRun,
      });
      if (dryRun) setResult({ validated: true });
      else navigate(back);
    } catch (e) {
      setResult({ error: e as Error });
    } finally {
      setSubmitting(undefined);
    }
  };

  return (
    <>
      <Header title={`Edit ${name}`} tags={[{ label: `project: ${namespace}` }]} breadcrumbs={[{ label: name, href: back }]} />
      <Container>
        {loadError && <ErrorAlert error={loadError} />}
        {!loadError && !form && <Skeleton width="100%" height={240} />}
        {!permissionLoading && !canUpdate && <Alert status="warning" title="You may not change this stack" />}
        {form && original && canUpdate && (
          <Grid.Root columns={{ initial: '1', lg: '3' }} gap="4">
            <Grid.Item colSpan={{ initial: '1', lg: '2' }}>
              <Flex direction="column" gap="4">
                <StackFormFields
                  form={form}
                  setForm={update}
                  errors={errors}
                  touched={touched}
                  editing
                  projects={projects}
                  gateways={gateways}
                  sizes={sizes}
                  extensions={extensions}
                />
              </Flex>
            </Grid.Item>
            <Grid.Item>
              <ManifestPanel
                title="Changes"
                manifest={preview}
                unchanged={unchanged}
                hasErrors={touched && hasErrors(errors)}
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
