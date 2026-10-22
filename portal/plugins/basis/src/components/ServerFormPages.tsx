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
  basisProjectCreatePermission,
  basisServerUpdatePermission,
  MODEL_URI_SOURCES,
  modelUriScheme,
  type ProjectSummary,
} from '@internal/backstage-plugin-basis-common';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useAsync from 'react-use/esm/useAsync';
import { stringify } from 'yaml';
import { basisApiRef } from '../api';
import { createProjectRouteRef, serverRouteRef } from '../routes';
import { ErrorAlert, ManifestPanel, Mono, Section } from './common';
import {
  defaultServerForm,
  fromServer,
  type ServerForm,
  servedName,
  toServerEditPatch,
  toServerManifest,
  toServerSpec,
  validateServer,
} from './serverForm';

const FIXED = 'Fixed after creation.';

/**
 * Every section of the server form, shared by the create and edit pages.
 * With `editing` the name and project are read-only.
 */
const ServerFormFields = ({
  form,
  setForm,
  err,
  editing,
  projects,
}: {
  form: ServerForm;
  setForm: (update: (f: ServerForm) => ServerForm) => void;
  err: (key: keyof ServerForm) => string | undefined;
  editing?: boolean;
  projects?: ProjectSummary[];
}) => {
  const set = <K extends keyof ServerForm>(key: K) => (value: ServerForm[K]) => setForm(f => ({ ...f, [key]: value }));
  const project = projects?.find(p => p.name === form.namespace);
  const scheme = modelUriScheme(form.uri.trim());
  let recoveryLocation = '';
  if (project) recoveryLocation = project.recoveryLocation ? ` (${project.recoveryLocation})` : ' (the project has none)';
  const source = scheme ? MODEL_URI_SOURCES[scheme] : undefined;

  return (
    <>
      <Section
        title="Server"
        description="An open model on the project's GPUs: vLLM run by KServe in the project's location. Gateways route to it like to any other model."
      >
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

      <Section title="Model" description="Where the weights come from, and the name vLLM serves them as.">
        <TextField
          label="Model URI"
          isRequired
          value={form.uri}
          onChange={set('uri')}
          placeholder={MODEL_URI_SOURCES.hf.example}
          description={
            err('uri') ??
            (source
              ? `${source.displayName}: ${source.description}`
              : 'hf://<org>/<model> (Hugging Face), pvc://<claim>/<path>, oci://<image> (modelcar) or s3://<bucket>/<path>.')
          }
          isInvalid={Boolean(err('uri'))}
        />
        <TextField
          label="Served as"
          value={form.servedName}
          onChange={set('servedName')}
          placeholder={form.name || 'the server\'s name'}
          description={
            err('servedName') ??
            `What clients send as model. A gateway's model named ${servedName(form)} gets prefix-cache-aware routing.`
          }
          isInvalid={Boolean(err('servedName'))}
        />
        {(scheme === 'hf' || form.tokenSecret) && (
          <TextField
            label="Hugging Face token (Secret)"
            value={form.tokenSecret}
            onChange={set('tokenSecret')}
            placeholder="none"
            description={err('tokenSecret') ?? 'For gated and private models: a Secret in the project with the token under HF_TOKEN.'}
            isInvalid={Boolean(err('tokenSecret'))}
          />
        )}
        {form.tokenSecret && (
          <Text variant="body-small" color="secondary">
            Create it once on the control plane:{' '}
            <Mono>
              kubectl -n {form.namespace || '<project>'} create secret generic {form.tokenSecret} --from-literal=HF_TOKEN=hf_...
            </Mono>
          </Text>
        )}
      </Section>

      <Section title="Replicas and GPUs" description="Per replica; every replica holds the whole model.">
        <NumberField
          label="Replicas"
          minValue={0}
          maxValue={20}
          value={form.replicas}
          onChange={set('replicas')}
          description={err('replicas') ?? '0 stops the server and frees its GPUs.'}
          isInvalid={Boolean(err('replicas'))}
        />
        <NumberField
          label="GPUs per replica"
          minValue={0}
          maxValue={8}
          value={form.gpus}
          onChange={set('gpus')}
          description={err('gpus') ?? (form.gpus > 1 ? 'The model is sharded over them (tensor parallel).' : '0 for a CPU-only vLLM image.')}
          isInvalid={Boolean(err('gpus'))}
        />
        <TextField
          label="CPU"
          value={form.cpu}
          onChange={set('cpu')}
          description={err('cpu') ?? 'e.g. 4 or 8'}
          isInvalid={Boolean(err('cpu'))}
        />
        <TextField
          label="Memory"
          value={form.memory}
          onChange={set('memory')}
          description={err('memory') ?? 'Request and limit, e.g. 32Gi.'}
          isInvalid={Boolean(err('memory'))}
        />
        <TextField
          label="GPU resource"
          value={form.gpuResource}
          onChange={set('gpuResource')}
          description={err('gpuResource') ?? 'How the nodes offer GPUs: nvidia.com/gpu, amd.com/gpu or a MIG profile.'}
          isInvalid={Boolean(err('gpuResource'))}
        />
        <TextField
          label="vLLM image"
          value={form.image}
          onChange={set('image')}
          placeholder="KServe's (llm-d's CUDA build)"
          description={err('image') ?? 'Another vendor\'s build, or vllm/vllm-openai-cpu:<version> without GPUs.'}
          isInvalid={Boolean(err('image'))}
        />
      </Section>

      <Section title="Routing and scheduling">
        <Switch label="Prefix-cache-aware routing (llm-d)" isSelected={form.prefixCacheAware} onChange={set('prefixCacheAware')} />
        <Text variant="body-small" color="secondary">
          {form.prefixCacheAware
            ? 'llm-d\'s scheduler sends each request to the replica that most likely has its prompt\'s prefix cached, weighed against load.'
            : 'Gateways balance the replicas round robin.'}
        </Text>
        <TextField
          label="vLLM flags"
          value={form.args}
          onChange={set('args')}
          placeholder="--max-model-len=16384"
          description={err('args') ?? 'One per line. The model, its name, the port and the tensor parallelism are set already.'}
          isInvalid={Boolean(err('args'))}
        />
        <TextField
          label="Node selector"
          value={form.nodeSelector}
          onChange={set('nodeSelector')}
          placeholder="nvidia.com/gpu.product=NVIDIA-H100-80GB-HBM3"
          description={err('nodeSelector') ?? 'label=value, comma-separated: which nodes the replicas may run on.'}
          isInvalid={Boolean(err('nodeSelector'))}
        />
        <TextField
          label="Tolerate taints"
          value={form.tolerations}
          onChange={set('tolerations')}
          placeholder="nvidia.com/gpu"
          description={err('tolerations') ?? 'Taint keys of the GPU nodes, comma-separated.'}
          isInvalid={Boolean(err('tolerations'))}
        />
      </Section>

      <Section title="Sites and alerts">
        <Switch
          label={`Also in the recovery site${recoveryLocation}`}
          isSelected={form.recovery}
          isDisabled={Boolean(project && !project.recoveryLocation)}
          onChange={set('recovery')}
        />
        {form.recovery && (
          <NumberField
            label="Replicas in the recovery site"
            minValue={0}
            maxValue={20}
            value={form.recoveryReplicas}
            onChange={set('recoveryReplicas')}
            description={err('recoveryReplicas') ?? '0 keeps it defined but stopped, holding no GPUs.'}
            isInvalid={Boolean(err('recoveryReplicas'))}
          />
        )}
        <Switch label="Alerts (no replica up, queueing, KV cache full, slow first token)" isSelected={form.alerts} onChange={set('alerts')} />
      </Section>
    </>
  );
};

export const CreateServerPage = () => {
  const api = useApi(basisApiRef);
  const navigate = useNavigate();
  const serverLink = useRouteRef(serverRouteRef);
  const createProjectLink = useRouteRef(createProjectRouteRef);
  const { allowed: canCreateProject } = usePermission({ permission: basisProjectCreatePermission });
  const { value: projects, loading: projectsLoading } = useAsync(() => api.listProjects(), [api]);
  const [form, setForm] = useState<ServerForm>(defaultServerForm);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState<'validate' | 'create'>();
  const [result, setResult] = useState<{ error?: Error; validated?: boolean }>({});

  const update = (fn: (f: ServerForm) => ServerForm) => {
    setForm(fn);
    setResult({});
  };
  const errors = useMemo(() => validateServer(form), [form]);
  const err = (key: keyof ServerForm) => (touched ? errors[key] : undefined);
  const manifest = useMemo(() => stringify(toServerManifest(form)), [form]);

  const submit = async (dryRun: boolean) => {
    setTouched(true);
    if (Object.keys(errors).length) return;
    setSubmitting(dryRun ? 'validate' : 'create');
    setResult({});
    try {
      await api.createServer({
        name: form.name,
        namespace: form.namespace,
        owner: form.owner || undefined,
        spec: toServerSpec(form),
        dryRun,
      });
      if (dryRun) setResult({ validated: true });
      else navigate(serverLink?.({ namespace: form.namespace, name: form.name }) ?? '/basis/servers');
    } catch (e) {
      setResult({ error: e as Error });
    } finally {
      setSubmitting(undefined);
    }
  };

  return (
    <>
      <Header title="Create model server" description="A self-hosted model: vLLM on KServe, with llm-d's prefix-cache-aware routing" />
      <Container>
        <Grid.Root columns={{ initial: '1', lg: '3' }} gap="4">
          <Grid.Item colSpan={{ initial: '1', lg: '2' }}>
            <Flex direction="column" gap="4">
              {!projectsLoading && projects?.length === 0 && (
                <Alert
                  status="info"
                  title="No projects yet"
                  description="A model server lives in a project and runs in its locations. Create a project first."
                  customActions={
                    canCreateProject && createProjectLink ? (
                      <ButtonLink href={createProjectLink()} variant="secondary" size="small">
                        Create project
                      </ButtonLink>
                    ) : undefined
                  }
                />
              )}
              <ServerFormFields form={form} setForm={update} err={err} projects={projects} />
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
              createLabel="Create server"
            />
          </Grid.Item>
        </Grid.Root>
      </Container>
    </>
  );
};

/** Changes a server's model, replicas, GPUs and routing; name and project are fixed. */
export const EditServerPage = () => {
  const { namespace = '', name = '' } = useParams();
  const api = useApi(basisApiRef);
  const navigate = useNavigate();
  const serverLink = useRouteRef(serverRouteRef);
  const { allowed: canUpdate, loading: permissionLoading } = usePermission({ permission: basisServerUpdatePermission });
  const { value: details, error: loadError } = useAsync(() => api.getServer(namespace, name), [api, namespace, name]);
  const { value: projects } = useAsync(() => api.listProjects().catch(() => []), [api]);
  const original = useMemo(() => details && fromServer(details.resource), [details]);
  const [form, setForm] = useState<ServerForm>();
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState<'validate' | 'create'>();
  const [result, setResult] = useState<{ error?: Error; validated?: boolean }>({});

  useEffect(() => {
    if (original) setForm(original);
  }, [original]);

  const update = (fn: (f: ServerForm) => ServerForm) => {
    setForm(f => f && fn(f));
    setResult({});
  };
  const errors = useMemo(() => (form ? validateServer(form) : {}), [form]);
  const err = (key: keyof ServerForm) => (touched ? errors[key] : undefined);
  const spec = useMemo(() => (form && original ? toServerEditPatch(original, form) : {}), [form, original]);
  const ownerChanged = Boolean(form && original && form.owner !== original.owner);
  const unchanged = Object.keys(spec).length === 0 && !ownerChanged;
  const preview = useMemo(() => stringify({ ...(ownerChanged ? { owner: form?.owner || null } : {}), spec }), [spec, ownerChanged, form]);
  const back = serverLink?.({ namespace, name }) ?? '/basis/servers';
  const stack = details?.summary.stack;

  const submit = async (dryRun: boolean) => {
    setTouched(true);
    if (Object.keys(errors).length) return;
    setSubmitting(dryRun ? 'validate' : 'create');
    setResult({});
    try {
      await api.patchServer(namespace, name, { spec, ...(ownerChanged ? { owner: form?.owner || null } : {}), dryRun });
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
        {stack && <Alert status="warning" title={`Part of stack ${stack}`} description="Change it through the stack." />}
        {form && original && canUpdate && !stack && (
          <Grid.Root columns={{ initial: '1', lg: '3' }} gap="4">
            <Grid.Item colSpan={{ initial: '1', lg: '2' }}>
              <Flex direction="column" gap="4">
                <Alert
                  status="info"
                  title="How changes apply"
                  description="KServe replaces the replicas; usually a new one loads the model before an old one goes, which needs a free GPU (or set the replicas to 0 first). Changing the served name breaks gateway models named after the old one."
                />
                <ServerFormFields form={form} setForm={update} err={err} editing projects={projects} />
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
