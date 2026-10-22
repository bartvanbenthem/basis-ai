import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  Alert,
  Button,
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
  basisGatewayUpdatePermission,
  basisProjectCreatePermission,
  type ProjectSummary,
} from '@internal/backstage-plugin-basis-common';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useAsync from 'react-use/esm/useAsync';
import { stringify } from 'yaml';
import { basisApiRef } from '../api';
import { createProjectRouteRef, gatewayRouteRef, stackRouteRef } from '../routes';
import { ErrorAlert, ManifestPanel, Section } from './common';
import {
  type ClientSettings,
  defaultGatewayForm,
  emptyClientSettings,
  fromGateway,
  type GatewayErrors,
  type GatewayForm,
  hasErrors,
  toGatewayEditPatch,
  toGatewayManifest,
  gatewayProviderKeys,
  toGatewaySpec,
  validateGateway,
} from './gatewayForm';
import { ExposeFields } from './ExposeFields';
import { emptyModel, ModelFields, useProjectServers } from './ModelFields';

const FIXED = 'Fixed after creation.';

/** Every section of the gateway form, shared by the create and edit pages. */
const GatewayFormFields = ({
  form,
  setForm,
  errors,
  touched,
  editing,
  projects,
}: {
  form: GatewayForm;
  setForm: (update: (f: GatewayForm) => GatewayForm) => void;
  errors: GatewayErrors;
  touched: boolean;
  editing?: boolean;
  projects?: ProjectSummary[];
}) => {
  const set = <K extends keyof GatewayForm>(key: K) => (value: GatewayForm[K]) => setForm(f => ({ ...f, [key]: value }));
  const servers = useProjectServers(form.namespace);
  const err = (key: Exclude<keyof GatewayErrors, 'modelRows'>) => (touched ? errors[key] : undefined);
  const project = projects?.find(p => p.name === form.namespace);
  const recoveryLocation = project?.recoveryLocation;

  return (
    <>
      <Section
        title="Gateway"
        description="One OpenAI-compatible endpoint to the project's models, hosted and self-hosted. Provider keys stay in the platform; every client gets a key of its own."
      >
        <TextField
          label="Name"
          isRequired
          isDisabled={editing}
          value={form.name}
          onChange={set('name')}
          description={
            err('name') ??
            (editing ? FIXED : `Clients call http://${form.name || '<name>'}.${form.namespace || '<project>'}.svc/v1.`)
          }
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

      <Section title="Sites" description="Agent Router runs in the project's protected location and, with a standby, in its recovery location too.">
        <NumberField label="Replicas (active site)" minValue={1} maxValue={10} value={form.replicas} onChange={set('replicas')} />
        <Switch
          label={recoveryLocation ? `Standby in ${recoveryLocation} (recovery site)` : 'Standby in the recovery site'}
          isSelected={form.recovery}
          isDisabled={!recoveryLocation && !form.recovery}
          onChange={set('recovery')}
        />
        {!recoveryLocation && (
          <Text variant="body-small" color="secondary">
            The project has no recovery location.
          </Text>
        )}
        {form.recovery && (
          <NumberField
            label="Standby replicas"
            minValue={0}
            maxValue={10}
            value={form.recoveryReplicas}
            onChange={set('recoveryReplicas')}
          />
        )}
      </Section>

      <Section
        title="Resilience"
        description="A failed request (a provider's 429 or 5xx, a broken connection) is retried with backoff, then goes to the model's fallbacks (set per model below), as many attempts each. Per-minute caps protect the providers' quotas; past one, clients get 429."
      >
        <NumberField
          label="Attempts per model"
          minValue={1}
          maxValue={5}
          value={form.retryAttempts}
          onChange={set('retryAttempts')}
          description="1 retries nothing."
        />
        <TextField
          label="Requests per minute (all clients)"
          value={form.requestsPerMinute}
          onChange={set('requestsPerMinute')}
          placeholder="no cap"
          description={err('requestsPerMinute') ?? 'Per site.'}
          isInvalid={Boolean(err('requestsPerMinute'))}
        />
        <TextField
          label="Tokens per minute (all clients)"
          value={form.tokensPerMinute}
          onChange={set('tokensPerMinute')}
          placeholder="no cap"
          description={err('tokensPerMinute') ?? 'Input and output, per site.'}
          isInvalid={Boolean(err('tokensPerMinute'))}
        />
      </Section>

      <Section
        title="Clients"
        description="Who may call the gateway: apps, agents, coding assistants. Each gets an API key in Secret <name>-keys; removing one revokes its key. A GenAI stack sharing this gateway is a client named after the stack."
      >
        <TextField
          label="Clients"
          value={form.clients.join(', ')}
          onChange={v => set('clients')(v.split(',').map(c => c.trim()))}
          description={err('clients') ?? 'Comma-separated, e.g. apps, support-bot, coding-agent.'}
          isInvalid={Boolean(err('clients'))}
        />
        <TextField
          label="Monthly token cap (all clients)"
          value={form.monthlyTokens}
          onChange={set('monthlyTokens')}
          placeholder="none"
          description={
            err('monthlyTokens') ?? 'Input and output tokens per calendar month, per site; past it the gateway answers 429.'
          }
          isInvalid={Boolean(err('monthlyTokens'))}
        />
        {form.clients.filter(Boolean).map(client => {
          const s = form.clientSettings[client] ?? emptyClientSettings();
          const setClient = (key: keyof ClientSettings) => (v: string) =>
            setForm(f => ({ ...f, clientSettings: { ...f.clientSettings, [client]: { ...s, [key]: v } } }));
          return (
            <Grid.Root key={client} columns={{ initial: '1', sm: '5' }} gap="2" style={{ gridColumn: '1 / -1' }}>
              <TextField label={`${client}: owner`} value={s.owner} onChange={setClient('owner')} placeholder="who to ask" />
              <TextField
                label={`${client}: monthly tokens`}
                value={s.monthlyTokens}
                onChange={setClient('monthlyTokens')}
                placeholder="no cap"
              />
              <TextField
                label={`${client}: requests/minute`}
                value={s.requestsPerMinute ?? ''}
                onChange={setClient('requestsPerMinute')}
                placeholder="no cap"
              />
              <TextField
                label={`${client}: tokens/minute`}
                value={s.tokensPerMinute ?? ''}
                onChange={setClient('tokensPerMinute')}
                placeholder="no cap"
              />
              <TextField
                label={`${client}: key expires`}
                value={s.expiresAt}
                onChange={setClient('expiresAt')}
                placeholder="YYYY-MM-DD"
              />
            </Grid.Root>
          );
        })}
        {err('clientSettings') && (
          <Text variant="body-small" color="danger">
            {err('clientSettings')}
          </Text>
        )}
      </Section>

      <Section
        title="External access"
        description="Internal by default: clients in the project's locations only. Exposed, the gateway also serves HTTPS on a load balancer of its own (Service <name>-external) for clients elsewhere; they still need a key."
      >
        <ExposeFields
          label="Expose over HTTPS"
          value={form.expose}
          onChange={set('expose')}
          errors={touched ? { hostname: errors.exposeHostname, sourceRanges: errors.exposeSourceRanges } : {}}
          hint="Only these reach the load balancer; 0.0.0.0/0 for everyone."
        />
      </Section>

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
            servers={servers}
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
    </>
  );
};

export const CreateGatewayPage = () => {
  const api = useApi(basisApiRef);
  const navigate = useNavigate();
  const gatewayLink = useRouteRef(gatewayRouteRef);
  const createProjectLink = useRouteRef(createProjectRouteRef);
  const { allowed: canCreateProject } = usePermission({ permission: basisProjectCreatePermission });
  const { value: projects, loading: projectsLoading } = useAsync(() => api.listProjects(), [api]);
  const [form, setForm] = useState<GatewayForm>(defaultGatewayForm);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState<'validate' | 'create'>();
  const [result, setResult] = useState<{ error?: Error; validated?: boolean }>({});

  const update = (fn: (f: GatewayForm) => GatewayForm) => {
    setForm(fn);
    setResult({});
  };
  const errors = useMemo(() => validateGateway(form), [form]);
  const manifest = useMemo(() => stringify(toGatewayManifest(form)), [form]);

  const submit = async (dryRun: boolean) => {
    setTouched(true);
    if (hasErrors(errors)) return;
    setSubmitting(dryRun ? 'validate' : 'create');
    setResult({});
    try {
      await api.createGateway({
        name: form.name,
        namespace: form.namespace,
        owner: form.owner || undefined,
        spec: toGatewaySpec(form),
        providerKeys: gatewayProviderKeys(form),
        dryRun,
      });
      if (dryRun) setResult({ validated: true });
      else navigate(gatewayLink?.({ namespace: form.namespace, name: form.name }) ?? '/basis/gateways');
    } catch (e) {
      setResult({ error: e as Error });
    } finally {
      setSubmitting(undefined);
    }
  };

  return (
    <>
      <Header
        title="Create model gateway"
        description="An OpenAI-compatible endpoint to a project's models, shared by its apps, agents and GenAI stacks"
      />
      <Container>
        <Grid.Root columns={{ initial: '1', lg: '3' }} gap="4">
          <Grid.Item colSpan={{ initial: '1', lg: '2' }}>
            <Flex direction="column" gap="4">
              {!projectsLoading && projects?.length === 0 && (
                <Alert
                  status="info"
                  title="No projects yet"
                  description="A gateway lives in a project and runs in its locations. Create a project first."
                  customActions={
                    canCreateProject && createProjectLink ? (
                      <ButtonLink href={createProjectLink()} variant="secondary" size="small">
                        Create project
                      </ButtonLink>
                    ) : undefined
                  }
                />
              )}
              <GatewayFormFields form={form} setForm={update} errors={errors} touched={touched} projects={projects} />
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
              createLabel="Create gateway"
            />
          </Grid.Item>
        </Grid.Root>
      </Container>
    </>
  );
};

/** Changes a gateway: replicas, standby, clients and models. Name and project are fixed. */
export const EditGatewayPage = () => {
  const { namespace = '', name = '' } = useParams();
  const api = useApi(basisApiRef);
  const navigate = useNavigate();
  const gatewayLink = useRouteRef(gatewayRouteRef);
  const stackLink = useRouteRef(stackRouteRef);
  const { allowed: canUpdate, loading: permissionLoading } = usePermission({ permission: basisGatewayUpdatePermission });
  const { value: gateway, error: loadError } = useAsync(() => api.getGateway(namespace, name), [api, namespace, name]);
  const { value: projects } = useAsync(() => api.listProjects().catch(() => []), [api]);
  const original = useMemo(() => gateway && fromGateway(gateway.resource), [gateway]);
  const [form, setForm] = useState<GatewayForm>();
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState<'validate' | 'create'>();
  const [result, setResult] = useState<{ error?: Error; validated?: boolean }>({});

  useEffect(() => {
    if (original) setForm(original);
  }, [original]);

  const update = (fn: (f: GatewayForm) => GatewayForm) => {
    setForm(f => f && fn(f));
    setResult({});
  };
  const errors = useMemo(() => (form ? validateGateway(form) : {}), [form]);
  const spec = useMemo(() => (form && original ? toGatewayEditPatch(original, form) : {}), [form, original]);
  const ownerChanged = Boolean(form && original && form.owner !== original.owner);
  const unchanged = Object.keys(spec).length === 0 && !ownerChanged;
  const preview = useMemo(
    () => stringify({ ...(ownerChanged ? { owner: form?.owner || null } : {}), spec }),
    [spec, ownerChanged, form],
  );
  const back = gatewayLink?.({ namespace, name }) ?? '/basis/gateways';
  const stack = gateway?.summary.stack;

  const submit = async (dryRun: boolean) => {
    setTouched(true);
    if (hasErrors(errors)) return;
    setSubmitting(dryRun ? 'validate' : 'create');
    setResult({});
    try {
      await api.patchGateway(namespace, name, {
        spec,
        providerKeys: form ? gatewayProviderKeys(form) : undefined,
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
        {!permissionLoading && !canUpdate && <Alert status="warning" title="You may not change this gateway" />}
        {stack && (
          <Alert
            status="info"
            title={`Part of stack ${stack}`}
            description="This gateway is the stack's own: change its models on the stack."
            customActions={
              stackLink ? (
                <ButtonLink href={stackLink({ namespace, name: stack })} variant="secondary" size="small">
                  Open stack
                </ButtonLink>
              ) : undefined
            }
          />
        )}
        {form && original && canUpdate && !stack && (
          <Grid.Root columns={{ initial: '1', lg: '3' }} gap="4">
            <Grid.Item colSpan={{ initial: '1', lg: '2' }}>
              <Flex direction="column" gap="4">
                <GatewayFormFields form={form} setForm={update} errors={errors} touched={touched} editing projects={projects} />
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
