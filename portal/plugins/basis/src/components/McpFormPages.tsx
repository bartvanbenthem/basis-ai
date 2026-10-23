import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  Alert,
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
  basisMcpUpdatePermission,
  basisProjectCreatePermission,
  MCP_TOOL_INFO,
  type McpTool,
  type ProjectSummary,
} from '@internal/backstage-plugin-basis-common';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useAsync from 'react-use/esm/useAsync';
import { stringify } from 'yaml';
import { basisApiRef } from '../api';
import { createProjectRouteRef, mcpServerRouteRef } from '../routes';
import { ErrorAlert, ManifestPanel, Section } from './common';
import {
  defaultMcpForm,
  effectiveMode,
  emptyMcpClientSettings,
  formEndpoint,
  formTools,
  fromMcpServer,
  type McpClientSettings,
  type McpErrors,
  type McpForm,
  toMcpEditPatch,
  toMcpManifest,
  toMcpSpec,
  validateMcp,
} from './mcpForm';

const FIXED = 'Fixed after creation.';
const AUTO = '__auto__';

/**
 * Every section of the MCP server form, shared by the create and edit pages.
 * With `editing` the name and project are read-only.
 */
const McpFormFields = ({
  form,
  setForm,
  err,
  editing,
  projects,
}: {
  form: McpForm;
  setForm: (update: (f: McpForm) => McpForm) => void;
  err: (key: keyof McpForm) => string | undefined;
  editing?: boolean;
  projects?: ProjectSummary[];
}) => {
  const api = useApi(basisApiRef);
  const set = <K extends keyof McpForm>(key: K) => (value: McpForm[K]) => setForm(f => ({ ...f, [key]: value }));
  const project = projects?.find(p => p.name === form.namespace);
  // What the project has to serve from, and to embed with.
  const { value: stacks } = useAsync(
    async () => (form.namespace ? api.listStacks(form.namespace).catch(() => []) : []),
    [api, form.namespace],
  );
  const { value: clusters } = useAsync(
    async () => (form.namespace ? api.listClusters(form.namespace).catch(() => []) : []),
    [api, form.namespace],
  );
  const { value: gateways } = useAsync(
    async () => (form.namespace && form.databaseKind === 'cluster' ? api.listGateways(form.namespace).catch(() => []) : []),
    [api, form.namespace, form.databaseKind],
  );
  const stack = stacks?.find(s => s.name === form.stack);
  const served = formTools(form);
  const clients = form.clients.map(c => c.trim()).filter(Boolean);
  let recoveryLocation = '';
  if (project) recoveryLocation = project.recoveryLocation ? ` (${project.recoveryLocation})` : ' (the project has none)';
  let modelHint = 'Empty: full-text search only.';
  if (form.databaseKind === 'stack' && stack?.models.length) modelHint = `The stack's gateway serves: ${stack.models.join(', ')}.`;
  else if (form.databaseKind === 'stack') modelHint = "A model the stack's gateway serves (add it to the stack's models). Empty: full-text search only.";

  return (
    <>
      <Section
        title="Server"
        description="An MCP server in the project's location: the project's knowledge base and the agents' memory as tools, for Claude Code, Codex or an agent of your own."
      >
        <TextField
          label="Name"
          isRequired
          isDisabled={editing}
          value={form.name}
          onChange={set('name')}
          description={err('name') ?? (editing ? FIXED : `Agents connect to ${formEndpoint(form)}.`)}
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
                // Another project has other stacks and clusters.
                stack: '',
                cluster: '',
                embeddingsGateway: '',
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
        title="Database"
        description="Where the documents and memories live. The server creates its tables there (schema mcp) and follows the database's primary to the active site."
      >
        <Select
          label="Serve from"
          value={form.databaseKind}
          onChange={k => set('databaseKind')(k === 'cluster' ? 'cluster' : 'stack')}
          options={[
            { id: 'stack', label: 'A GenAI stack (its role, and its gateway for embeddings)' },
            { id: 'cluster', label: 'A PostgreSQL cluster' },
          ]}
        />
        {form.databaseKind === 'stack' ? (
          <Select
            label="GenAI stack"
            isRequired
            value={form.stack || null}
            onChange={k => set('stack')(String(k ?? ''))}
            options={(stacks ?? []).map(s => ({ id: s.name, label: s.name }))}
            placeholder={form.namespace ? 'Pick a stack' : 'Pick a project first'}
            description={err('stack') ?? (stacks && stacks.length === 0 && form.namespace ? 'The project has no GenAI stacks.' : undefined)}
            isInvalid={Boolean(err('stack'))}
          />
        ) : (
          <>
            <Select
              label="PostgreSQL cluster"
              isRequired
              value={form.cluster || null}
              onChange={k => set('cluster')(String(k ?? ''))}
              options={(clusters ?? []).map(c => ({ id: c.name, label: c.name }))}
              placeholder={form.namespace ? 'Pick a cluster' : 'Pick a project first'}
              description={err('cluster') ?? 'With embeddings it needs the vector extension.'}
              isInvalid={Boolean(err('cluster'))}
            />
            <TextField
              label="Database"
              value={form.databaseName}
              onChange={set('databaseName')}
              placeholder="app"
              description={err('databaseName') ?? 'The cluster\'s database; app by default.'}
              isInvalid={Boolean(err('databaseName'))}
            />
            <TextField
              label="Role's Secret"
              value={form.credentialsSecret}
              onChange={set('credentialsSecret')}
              placeholder="the database owner"
              description={
                err('credentialsSecret') ??
                'A basic-auth Secret of one of the cluster\'s roles (its spec.roles). Empty: the database owner, in the protected site only.'
              }
              isInvalid={Boolean(err('credentialsSecret'))}
            />
          </>
        )}
      </Section>

      <Section
        title="Embeddings"
        description="Vectors for semantic search and recall, from the project's model gateway: the data and the vectors stay in the project's database."
      >
        <TextField
          label="Embeddings model"
          value={form.embeddingsModel}
          onChange={set('embeddingsModel')}
          placeholder="text-embedding-3-small"
          description={err('embeddingsModel') ?? modelHint}
          isInvalid={Boolean(err('embeddingsModel'))}
        />
        {form.databaseKind === 'cluster' && (
          <>
            <Select
              label="Model gateway"
              value={form.embeddingsGateway || null}
              onChange={k => set('embeddingsGateway')(String(k ?? ''))}
              options={(gateways ?? []).map(g => ({ id: g.name, label: g.name }))}
              placeholder="Pick a gateway"
              description={err('embeddingsGateway') ?? 'It needs a client named after the server (or the client below) in its clients.'}
              isInvalid={Boolean(err('embeddingsGateway'))}
            />
            <TextField
              label="Client at the gateway"
              value={form.embeddingsClient}
              onChange={set('embeddingsClient')}
              placeholder={form.name || 'the server\'s name'}
              description={err('embeddingsClient')}
              isInvalid={Boolean(err('embeddingsClient'))}
            />
          </>
        )}
        <TextField
          label="Dimensions"
          value={form.dimensions}
          onChange={set('dimensions')}
          placeholder="the model's own"
          description={err('dimensions') ?? 'Only for models that can shorten their vectors. Changing the model later needs new tables.'}
          isInvalid={Boolean(err('dimensions'))}
        />
      </Section>

      <Section title="Knowledge base" description="search and fetch over documents; with ingest, agents add and remove them too.">
        <Switch label="Retrieval (search, fetch)" isSelected={form.retrieval} onChange={set('retrieval')} />
        {form.retrieval && (
          <>
            <Select
              label="Search"
              value={form.mode || AUTO}
              onChange={k => set('mode')(k === AUTO ? '' : (String(k) as McpForm['mode']))}
              options={[
                { id: AUTO, label: `Automatic (${effectiveMode({ ...form, mode: '' })})` },
                { id: 'hybrid', label: 'Hybrid: vectors and full text, fused' },
                { id: 'vector', label: 'Vectors only' },
                { id: 'text', label: 'Full text only' },
              ]}
              description={err('mode')}
              isInvalid={Boolean(err('mode'))}
            />
            <NumberField
              label="Hits per search"
              minValue={1}
              maxValue={50}
              value={form.topK}
              onChange={set('topK')}
              description={err('topK') ?? 'Unless the agent asks for another number.'}
              isInvalid={Boolean(err('topK'))}
            />
            <TextField
              label="Text search configuration"
              value={form.textSearchConfig}
              onChange={set('textSearchConfig')}
              description={err('textSearchConfig') ?? "PostgreSQL's: simple (any language, no stemming), english, dutch, german..."}
              isInvalid={Boolean(err('textSearchConfig'))}
            />
            <TextField
              label="Table of your own"
              value={form.table}
              onChange={set('table')}
              placeholder="mcp.documents (the server's own)"
              description={err('table') ?? 'schema.table of documents you fill yourself; the server only reads it.'}
              isInvalid={Boolean(err('table'))}
            />
            {form.table && (
              <Grid.Root columns={{ initial: '1', sm: '3' }} gap="2" style={{ gridColumn: '1 / -1' }}>
                {(['id', 'content', 'title', 'source', 'metadata', 'embedding'] as const).map(col => (
                  <TextField
                    key={col}
                    label={`Column: ${col}`}
                    isRequired={col === 'id' || col === 'content'}
                    value={form.columns[col]}
                    onChange={v => setForm(f => ({ ...f, columns: { ...f.columns, [col]: v } }))}
                    placeholder={col === 'id' || col === 'content' ? col : 'none'}
                  />
                ))}
              </Grid.Root>
            )}
            {err('columns') && (
              <Text variant="body-small" color="danger">
                {err('columns')}
              </Text>
            )}
            <Switch
              label="Ingest (add_document, delete_document)"
              isSelected={form.ingest}
              isDisabled={Boolean(form.table)}
              onChange={set('ingest')}
            />
            {err('ingest') && (
              <Text variant="body-small" color="danger">
                {err('ingest')}
              </Text>
            )}
          </>
        )}
      </Section>

      <Section title="Memory" description="remember, recall and forget: what agents keep between conversations.">
        <Switch label="Memory (remember, recall, forget)" isSelected={form.memory} onChange={set('memory')} />
        {err('memory') && (
          <Text variant="body-small" color="danger">
            {err('memory')}
          </Text>
        )}
        {form.memory && (
          <>
            <Select
              label="Scope"
              value={form.memoryScope}
              onChange={k => set('memoryScope')(k === 'shared' ? 'shared' : 'client')}
              options={[
                { id: 'client', label: 'Each client its own memories' },
                { id: 'shared', label: 'Shared by every client' },
              ]}
            />
            <TextField
              label="Keep for (days)"
              value={form.retentionDays}
              onChange={set('retentionDays')}
              placeholder="forever"
              description={err('retentionDays') ?? 'Older memories are deleted.'}
              isInvalid={Boolean(err('retentionDays'))}
            />
          </>
        )}
      </Section>

      <Section title="Clients" description="Each client gets an API key of its own (Secret <name>-keys); removing one revokes its key.">
        <TextField
          label="Clients"
          value={form.clients.join(', ')}
          onChange={v => set('clients')(v.split(',').map(c => c.trim()))}
          description={err('clients') ?? 'Comma-separated, e.g. claude-code, support-bot.'}
          isInvalid={Boolean(err('clients'))}
        />
        {clients.map(client => {
          const s = form.clientSettings[client] ?? emptyMcpClientSettings();
          const setClient = <K extends keyof McpClientSettings>(key: K) => (v: McpClientSettings[K]) =>
            setForm(f => ({ ...f, clientSettings: { ...f.clientSettings, [client]: { ...s, [key]: v } } }));
          return (
            <Flex key={client} direction="column" gap="2" style={{ gridColumn: '1 / -1' }}>
              <Grid.Root columns={{ initial: '1', sm: '2' }} gap="2">
                <TextField label={`${client}: owner`} value={s.owner} onChange={setClient('owner')} placeholder="who to ask" />
                <TextField label={`${client}: key expires`} value={s.expiresAt} onChange={setClient('expiresAt')} placeholder="YYYY-MM-DD" />
              </Grid.Root>
              <CheckboxGroup
                label={`${client}: tools (none ticked: all the server serves)`}
                value={s.tools}
                onChange={v => setClient('tools')(v as McpTool[])}
              >
                <Flex gap="3" style={{ flexWrap: 'wrap' }}>
                  {served.map(t => (
                    <Checkbox key={t} value={t}>
                      <Text title={MCP_TOOL_INFO[t].description}>{t}</Text>
                    </Checkbox>
                  ))}
                </Flex>
              </CheckboxGroup>
            </Flex>
          );
        })}
        {err('clientSettings') && (
          <Text variant="body-small" color="danger">
            {err('clientSettings')}
          </Text>
        )}
      </Section>

      <Section title="Sites, size and alerts">
        <NumberField
          label="Replicas"
          minValue={1}
          maxValue={10}
          value={form.replicas}
          onChange={set('replicas')}
          description={err('replicas') ?? 'In the active site; any replica answers any request.'}
          isInvalid={Boolean(err('replicas'))}
        />
        <TextField label="CPU per replica" value={form.cpu} onChange={set('cpu')} description={err('cpu')} isInvalid={Boolean(err('cpu'))} />
        <TextField
          label="Memory per replica"
          value={form.memoryLimit}
          onChange={set('memoryLimit')}
          description={err('memoryLimit')}
          isInvalid={Boolean(err('memoryLimit'))}
        />
        <Switch
          label={`Also in the recovery site${recoveryLocation}`}
          isSelected={form.recovery}
          isDisabled={Boolean(project && !project.recoveryLocation)}
          onChange={set('recovery')}
        />
        {form.recovery && (
          <NumberField
            label="Replicas in the standby site"
            minValue={0}
            maxValue={10}
            value={form.recoveryReplicas}
            onChange={set('recoveryReplicas')}
            description={err('recoveryReplicas') ?? 'Search, fetch and recall from the replica; every tool once the database moves there.'}
            isInvalid={Boolean(err('recoveryReplicas'))}
          />
        )}
        <Switch label="Alerts (down, database not ready, failing or slow tool calls)" isSelected={form.alerts} onChange={set('alerts')} />
      </Section>
    </>
  );
};

const hasErrors = (e: McpErrors) => Object.keys(e).length > 0;

export const CreateMcpPage = () => {
  const api = useApi(basisApiRef);
  const navigate = useNavigate();
  const serverLink = useRouteRef(mcpServerRouteRef);
  const createProjectLink = useRouteRef(createProjectRouteRef);
  const { allowed: canCreateProject } = usePermission({ permission: basisProjectCreatePermission });
  const { value: projects, loading: projectsLoading } = useAsync(() => api.listProjects(), [api]);
  const [form, setForm] = useState<McpForm>(defaultMcpForm);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState<'validate' | 'create'>();
  const [result, setResult] = useState<{ error?: Error; validated?: boolean }>({});

  const update = (fn: (f: McpForm) => McpForm) => {
    setForm(fn);
    setResult({});
  };
  const errors = useMemo(() => validateMcp(form), [form]);
  const err = (key: keyof McpForm) => (touched ? errors[key] : undefined);
  const manifest = useMemo(() => stringify(toMcpManifest(form)), [form]);

  const submit = async (dryRun: boolean) => {
    setTouched(true);
    if (hasErrors(errors)) return;
    setSubmitting(dryRun ? 'validate' : 'create');
    setResult({});
    try {
      await api.createMcpServer({
        name: form.name,
        namespace: form.namespace,
        owner: form.owner || undefined,
        spec: toMcpSpec(form),
        dryRun,
      });
      if (dryRun) setResult({ validated: true });
      else navigate(serverLink?.({ namespace: form.namespace, name: form.name }) ?? '/basis/mcp-servers');
    } catch (e) {
      setResult({ error: e as Error });
    } finally {
      setSubmitting(undefined);
    }
  };

  return (
    <>
      <Header title="Create MCP server" description="Retrieval over a project's database and the agents' memory, as MCP tools" />
      <Container>
        <Grid.Root columns={{ initial: '1', lg: '3' }} gap="4">
          <Grid.Item colSpan={{ initial: '1', lg: '2' }}>
            <Flex direction="column" gap="4">
              {!projectsLoading && projects?.length === 0 && (
                <Alert
                  status="info"
                  title="No projects yet"
                  description="An MCP server lives in a project, over one of its GenAI stacks or PostgreSQL clusters. Create a project first."
                  customActions={
                    canCreateProject && createProjectLink ? (
                      <ButtonLink href={createProjectLink()} variant="secondary" size="small">
                        Create project
                      </ButtonLink>
                    ) : undefined
                  }
                />
              )}
              <McpFormFields form={form} setForm={update} err={err} projects={projects} />
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
              createLabel="Create MCP server"
            />
          </Grid.Item>
        </Grid.Root>
      </Container>
    </>
  );
};

/** Changes a server's database, search, memory and clients; name and project are fixed. */
export const EditMcpPage = () => {
  const { namespace = '', name = '' } = useParams();
  const api = useApi(basisApiRef);
  const navigate = useNavigate();
  const serverLink = useRouteRef(mcpServerRouteRef);
  const { allowed: canUpdate, loading: permissionLoading } = usePermission({ permission: basisMcpUpdatePermission });
  const { value: details, error: loadError } = useAsync(() => api.getMcpServer(namespace, name), [api, namespace, name]);
  const { value: projects } = useAsync(() => api.listProjects().catch(() => []), [api]);
  const original = useMemo(() => details && fromMcpServer(details.resource), [details]);
  const [form, setForm] = useState<McpForm>();
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState<'validate' | 'create'>();
  const [result, setResult] = useState<{ error?: Error; validated?: boolean }>({});

  useEffect(() => {
    if (original) setForm(original);
  }, [original]);

  const update = (fn: (f: McpForm) => McpForm) => {
    setForm(f => f && fn(f));
    setResult({});
  };
  const errors = useMemo(() => (form ? validateMcp(form) : {}), [form]);
  const err = (key: keyof McpForm) => (touched ? errors[key] : undefined);
  const spec = useMemo(() => (form && original ? toMcpEditPatch(original, form) : {}), [form, original]);
  const ownerChanged = Boolean(form && original && form.owner !== original.owner);
  const unchanged = Object.keys(spec).length === 0 && !ownerChanged;
  const preview = useMemo(() => stringify({ ...(ownerChanged ? { owner: form?.owner || null } : {}), spec }), [spec, ownerChanged, form]);
  const back = serverLink?.({ namespace, name }) ?? '/basis/mcp-servers';

  const submit = async (dryRun: boolean) => {
    setTouched(true);
    if (hasErrors(errors)) return;
    setSubmitting(dryRun ? 'validate' : 'create');
    setResult({});
    try {
      await api.patchMcpServer(namespace, name, { spec, ...(ownerChanged ? { owner: form?.owner || null } : {}), dryRun });
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
        {!permissionLoading && !canUpdate && <Alert status="warning" title="You may not change this server" />}
        {form && original && canUpdate && (
          <Grid.Root columns={{ initial: '1', lg: '3' }} gap="4">
            <Grid.Item colSpan={{ initial: '1', lg: '2' }}>
              <Flex direction="column" gap="4">
                <Alert
                  status="info"
                  title="How changes apply"
                  description="A change to what the server serves rolls its pods, one at a time; new clients' keys are read in place. Another database has its own mcp tables (the old ones stay). An embeddings model with other dimensions than the tables' is refused by the server: keep the model, or use new tables."
                />
                <McpFormFields form={form} setForm={update} err={err} editing projects={projects} />
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
