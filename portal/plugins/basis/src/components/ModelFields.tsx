import { useApi } from '@backstage/frontend-plugin-api';
import { Button, Card, CardBody, Flex, Grid, PasswordField, Select, Text, TextField } from '@backstage/ui';
import {
  MODEL_SCHEMAS,
  PROVIDER_KEY_FIELD,
  providerKeySecretName,
  type GatewayModel,
  type ModelSchema,
  type ModelServerSummary,
} from '@internal/backstage-plugin-basis-common';
import useAsync from 'react-use/esm/useAsync';
import { basisApiRef } from '../api';
import { Mono } from './common';

/**
 * Where a model's provider key comes from: entered here (the portal writes
 * it into a Secret), already stored by the portal earlier, a Secret of your
 * own, or none (an endpoint without auth).
 */
export type KeySource = 'enter' | 'stored' | 'secret' | 'none';

/** Where a model runs: a provider's API (an endpoint), or a ModelServer in the project. */
export type ModelSource = 'endpoint' | 'server';

/** One model row of a gateway form. */
export interface ModelRow {
  name: string;
  /** "endpoint" when unset. */
  source?: ModelSource;
  endpoint: string;
  /** The ModelServer, with source "server". */
  server?: string;
  schema: ModelSchema;
  upstreamModel: string;
  keySource: KeySource;
  /** The key, with keySource "enter"; sent next to the spec, never in it. */
  apiKey: string;
  /** The Secret in the project namespace, with keySource "stored" or "secret". */
  secretName: string;
  secretKey: string;
  /** Other models to try, in order, comma-separated. */
  fallbacks?: string;
}

export const emptyModel = (): ModelRow => ({
  name: '',
  source: 'endpoint',
  endpoint: '',
  server: '',
  schema: 'OpenAI',
  upstreamModel: '',
  keySource: 'enter',
  apiKey: '',
  secretName: '',
  secretKey: PROVIDER_KEY_FIELD,
  fallbacks: '',
});

/** A model as the form shows it; `owner` is the stack or gateway, for the Secrets the portal wrote. */
export const fromModel = (m: GatewayModel, owner: string): ModelRow => {
  const ref = m.apiKeySecretRef;
  let keySource: KeySource = 'none';
  if (ref) keySource = ref.name === providerKeySecretName(owner, m.name) ? 'stored' : 'secret';
  return {
    name: m.name,
    source: m.server ? 'server' : 'endpoint',
    endpoint: m.endpoint ?? '',
    server: m.server ?? '',
    schema: m.schema ?? 'OpenAI',
    upstreamModel: m.upstreamModel ?? '',
    keySource,
    apiKey: '',
    secretName: ref?.name ?? '',
    secretKey: ref?.key ?? PROVIDER_KEY_FIELD,
    fallbacks: (m.fallbacks ?? []).join(', '),
  };
};

/** A row's fallbacks, comma-separated in the form. */const fallbackList = (m: ModelRow) =>
  (m.fallbacks ?? '')
    .split(',')
    .map(f => f.trim())
    .filter(Boolean);

/** The rows as the XRD's models; `owner` names the Secrets the portal writes keys into. */
export const toModels = (rows: ModelRow[], owner: string) =>
  rows
    .filter(m => m.name.trim())
    .map(m => {
      const name = m.name.trim();
      if (m.source === 'server') {
        // Self-hosted: its ModelServer serves it; no API, provider name or key.
        return { name, server: (m.server ?? '').trim(), ...(fallbackList(m).length ? { fallbacks: fallbackList(m) } : {}) };
      }
      let ref: { name: string; key: string } | undefined;
      if (m.keySource === 'enter') ref = { name: providerKeySecretName(owner || '<name>', name), key: PROVIDER_KEY_FIELD };
      if (m.keySource === 'stored' || m.keySource === 'secret') {
        ref = { name: m.secretName.trim(), key: m.secretKey.trim() || PROVIDER_KEY_FIELD };
      }
      return {
        name,
        endpoint: m.endpoint.trim(),
        schema: m.schema,
        ...(m.upstreamModel.trim() ? { upstreamModel: m.upstreamModel.trim() } : {}),
        ...(ref ? { apiKeySecretRef: ref } : {}),
        ...(fallbackList(m).length ? { fallbacks: fallbackList(m) } : {}),
      };
    });


/**
 * The keys entered in the form, by model name: what the portal writes into Secrets. Without
 * whitespace: a token pasted from a wrapped display has line breaks the provider rejects.
 */
export const providerKeys = (rows: ModelRow[]): Record<string, string> | undefined => {
  const keys = Object.fromEntries(
    rows
      .filter(m => m.source !== 'server' && m.keySource === 'enter' && m.name.trim() && m.apiKey.trim())
      .map(m => [m.name.trim(), m.apiKey.replace(/\s+/g, '')]),
  );
  return Object.keys(keys).length ? keys : undefined;
};

const ENDPOINT = /^https?:\/\/[^/:]+(:[0-9]+)?(\/.*)?$/;
const SERVER = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const K8S_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const SECRET_KEY = /^[-._a-zA-Z0-9]+$/;

/** Errors per model row; mirrors the XRD's rules. */
export function validateModels(rows: ModelRow[]): Record<number, string> {
  const errors: Record<number, string> = {};
  const seen = new Set<string>();
  const names = new Set(rows.map(m => m.name.trim()));
  rows.forEach((m, i) => {
    const unknown = fallbackList(m).find(f => f === m.name.trim() || !names.has(f));
    if (!m.name.trim()) errors[i] = 'Give the model the name clients send.';
    else if (seen.has(m.name)) errors[i] = `Model ${m.name} is listed twice.`;
    else if (m.source === 'server') {
      if (!SERVER.test(m.server ?? '')) errors[i] = 'Pick the model server it runs on.';
      else if (unknown) errors[i] = `Fallback ${unknown}: name another model of this gateway.`;
    } else if (!ENDPOINT.test(m.endpoint)) errors[i] = 'The endpoint is a URL, e.g. https://api.openai.com/v1.';
    else if (m.keySource === 'enter' && !m.apiKey.trim()) errors[i] = "Enter the provider's API key, or pick another key source.";
    else if (m.keySource === 'secret' && !K8S_NAME.test(m.secretName)) errors[i] = 'The Secret name is a Kubernetes name, e.g. stackit.';
    // A pasted token passes the XRD's character rule (a JWT does), not this.
    else if (m.keySource === 'secret' && (!SECRET_KEY.test(m.secretKey) || m.secretKey.length > 63)) {
      errors[i] = 'The key in the Secret is a name like apiKey, not the token itself.';
    } else if (unknown) errors[i] = `Fallback ${unknown}: name another model of this gateway.`;
    seen.add(m.name);
  });
  return errors;
}

const SOURCES: Array<{ id: KeySource; label: string }> = [
  { id: 'enter', label: 'Enter the key (the portal stores it in a Secret)' },
  { id: 'secret', label: 'A Secret of my own in the project' },
  { id: 'none', label: 'None (an endpoint without auth, e.g. your own vLLM)' },
];

/** The project's ModelServers, for the self-hosted models of a gateway or stack form. */
export function useProjectServers(namespace: string): ModelServerSummary[] | undefined {
  const api = useApi(basisApiRef);
  const { value } = useAsync(
    () => (namespace ? api.listServers(namespace).catch(() => []) : Promise.resolve([])),
    [api, namespace],
  );
  return value;
}

/** The self-hosted part of a model card: which ModelServer, and how the gateway reaches it. */
const ServerFields = ({
  model,
  servers,
  namespace,
  set,
}: {
  model: ModelRow;
  servers?: ModelServerSummary[];
  namespace: string;
  set: <K extends keyof ModelRow>(key: K) => (value: ModelRow[K]) => void;
}) => {
  const server = servers?.find(s => s.name === model.server);
  const options = (servers ?? []).map(s => ({ id: s.name, label: `${s.name} (serves ${s.model})` }));
  if (model.server && !server) options.push({ id: model.server, label: model.server });
  let hint = 'A ModelServer in this project: vLLM on its GPUs, with prefix-cache-aware routing.';
  if (server && server.model !== model.name.trim()) {
    hint = `It serves the model as ${server.model}: name the model so for prefix-cache-aware routing; otherwise the gateway renames it and balances round robin.`;
  } else if (server && !server.prefixCacheAware) {
    hint = 'Balanced round robin: the server has prefix-cache-aware routing off.';
  } else if (server && model.fallbacks?.trim()) {
    hint = 'With fallbacks the gateway balances it round robin (Agent Router puts no fallbacks next to a pool).';
  }
  return (
    <>
      <Select
        label="Model server"
        isRequired
        value={model.server || null}
        onChange={k => set('server')(String(k ?? ''))}
        options={options}
        placeholder={servers && !servers.length ? `No model servers in ${namespace || 'the project'}` : 'Pick a server'}
        description={hint}
      />
      <TextField
        label="Fallbacks"
        value={model.fallbacks ?? ''}
        onChange={set('fallbacks')}
        placeholder="none"
        description="Other models of this gateway to try, in order, when this one fails, e.g. a hosted model."
      />
    </>
  );
};

/** One model the gateway routes to. */
export const ModelFields = ({
  model,
  index,
  error,
  namespace,
  owner,
  servers,
  onChange,
  onRemove,
}: {
  model: ModelRow;
  index: number;
  error?: string;
  namespace: string;
  /** The stack or gateway: names the Secret the portal writes the key into. */
  owner: string;
  /** The project's ModelServers, for self-hosted models. */
  servers?: ModelServerSummary[];
  onChange: (m: ModelRow) => void;
  onRemove: () => void;
}) => {
  const set = <K extends keyof ModelRow>(key: K) => (value: ModelRow[K]) => onChange({ ...model, [key]: value });
  const sources = model.keySource === 'stored' ? [{ id: 'stored' as const, label: 'Stored by the portal' }, ...SOURCES] : SOURCES;
  const selfHosted = model.source === 'server';
  return (
    <Card>
      <CardBody>
        <Flex direction="column" gap="3">
          <Grid.Root columns={{ initial: '1', md: '2' }} gap="3">
            <TextField
              label="Model name"
              isRequired
              value={model.name}
              onChange={set('name')}
              description="What clients send as model, e.g. gpt-oss-120b."
            />
            <Select
              label="Runs on"
              value={model.source ?? 'endpoint'}
              onChange={k => {
                const source = (k as ModelSource) ?? 'endpoint';
                // The project's only server, and its served name, unless set already.
                const only = servers?.length === 1 ? servers[0] : undefined;
                onChange({
                  ...model,
                  source,
                  ...(source === 'server' && only && !model.server ? { server: only.name, name: model.name.trim() || only.model } : {}),
                });
              }}
              options={[
                { id: 'endpoint', label: "A provider's API (hosted, or an OpenAI-compatible server of your own)" },
                { id: 'server', label: 'A model server in this project (self-hosted)' },
              ]}
            />
            {selfHosted ? (
              <ServerFields model={model} servers={servers} namespace={namespace} set={set} />
            ) : (
              <>
                <Select
                  label="API"
                  value={model.schema}
                  onChange={k => set('schema')((k as ModelSchema) ?? 'OpenAI')}
                  options={MODEL_SCHEMAS.map(s => ({ id: s, label: s === 'OpenAI' ? 'OpenAI (and OpenAI-compatible: vLLM, KServe, Ollama, STACKIT, ...)' : s }))}
                />
                <TextField
                  label="Endpoint"
                  isRequired
                  value={model.endpoint}
                  onChange={set('endpoint')}
                  placeholder="https://api.openai.com/v1"
                  description="Base URL of the provider's API; its path is the API prefix."
                />
                <TextField
                  label="Model at the provider"
                  value={model.upstreamModel}
                  onChange={set('upstreamModel')}
                  description="When it differs from the model name, e.g. openai/gpt-oss-120b."
                />
                <TextField
                  label="Fallbacks"
                  value={model.fallbacks ?? ''}
                  onChange={set('fallbacks')}
                  placeholder="none"
                  description="Other models of this gateway to try, in order, when this one fails, e.g. llama, mistral-large."
                />
                <Select
                  label="Provider API key"
                  value={model.keySource}
                  onChange={k => onChange({ ...model, keySource: (k as KeySource) ?? 'enter' })}
                  options={sources}
                />
                {model.keySource === 'enter' && (
                  <PasswordField label="API key" value={model.apiKey} onChange={set('apiKey')} placeholder="sk-... or your provider's token" />
                )}
                {model.keySource === 'secret' && (
                  <TextField
                    label="Secret name"
                    value={model.secretName}
                    onChange={set('secretName')}
                    description={`A Secret you created in project ${namespace || '<project>'}.`}
                  />
                )}
              </>
            )}
          </Grid.Root>
          {!selfHosted && model.keySource === 'enter' && (
            <Text variant="body-small" color="secondary">
              Stored in Secret <Mono>{providerKeySecretName(owner || '<name>', model.name.trim() || '<model>')}</Mono> in the
              project, never in the manifest; only the gateway reads it.
            </Text>
          )}
          {!selfHosted && model.keySource === 'stored' && (
            <Text variant="body-small" color="secondary">
              The key is stored in Secret <Mono>{model.secretName}</Mono>. Pick "Enter the key" to replace it.
            </Text>
          )}
          {!selfHosted && model.keySource === 'secret' && (
            <Flex direction="column" gap="2">
              <TextField
                label="Key in the Secret"
                value={model.secretKey}
                onChange={set('secretKey')}
                description="The name the token is stored under (usually apiKey), not the token."
              />
              <Text variant="body-small" color="secondary">
                Create it once on the control plane, with the token where it says TOKEN:{' '}
                <Mono>
                  kubectl -n {namespace || '<project>'} create secret generic {model.secretName || '<secret-name>'}{' '}
                  --from-literal={model.secretKey || PROVIDER_KEY_FIELD}=TOKEN
                </Mono>
              </Text>
            </Flex>
          )}
          {error && (
            <Text variant="body-small" color="danger">
              {error}
            </Text>
          )}
          <Flex justify="end">
            <Button size="small" variant="secondary" onPress={onRemove} aria-label={`Remove model ${index + 1}`}>
              Remove
            </Button>
          </Flex>
        </Flex>
      </CardBody>
    </Card>
  );
};
