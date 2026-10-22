import { Button, Card, CardBody, Flex, Grid, PasswordField, Select, Text, TextField } from '@backstage/ui';
import {
  MODEL_SCHEMAS,
  PROVIDER_KEY_FIELD,
  providerKeySecretName,
  type GatewayModel,
  type ModelSchema,
} from '@internal/backstage-plugin-basis-common';
import { Mono } from './common';

/**
 * Where a model's provider key comes from: entered here (the portal writes
 * it into a Secret), already stored by the portal earlier, a Secret of your
 * own, or none (an endpoint without auth).
 */
export type KeySource = 'enter' | 'stored' | 'secret' | 'none';

/** One model row of a gateway form. */
export interface ModelRow {
  name: string;
  endpoint: string;
  schema: ModelSchema;
  upstreamModel: string;
  keySource: KeySource;
  /** The key, with keySource "enter"; sent next to the spec, never in it. */
  apiKey: string;
  /** The Secret in the project namespace, with keySource "stored" or "secret". */
  secretName: string;
  secretKey: string;
}

export const emptyModel = (): ModelRow => ({
  name: '',
  endpoint: '',
  schema: 'OpenAI',
  upstreamModel: '',
  keySource: 'enter',
  apiKey: '',
  secretName: '',
  secretKey: PROVIDER_KEY_FIELD,
});

/** A model as the form shows it; `owner` is the stack or gateway, for the Secrets the portal wrote. */
export const fromModel = (m: GatewayModel, owner: string): ModelRow => {
  const ref = m.apiKeySecretRef;
  let keySource: KeySource = 'none';
  if (ref) keySource = ref.name === providerKeySecretName(owner, m.name) ? 'stored' : 'secret';
  return {
    name: m.name,
    endpoint: m.endpoint,
    schema: m.schema ?? 'OpenAI',
    upstreamModel: m.upstreamModel ?? '',
    keySource,
    apiKey: '',
    secretName: ref?.name ?? '',
    secretKey: ref?.key ?? PROVIDER_KEY_FIELD,
  };
};

/** The rows as the XRD's models; `owner` names the Secrets the portal writes keys into. */
export const toModels = (rows: ModelRow[], owner: string) =>
  rows
    .filter(m => m.name.trim())
    .map(m => {
      const name = m.name.trim();
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
      };
    });

/**
 * The keys entered in the form, by model name: what the portal writes into Secrets. Without
 * whitespace: a token pasted from a wrapped display has line breaks the provider rejects.
 */
export const providerKeys = (rows: ModelRow[]): Record<string, string> | undefined => {
  const keys = Object.fromEntries(
    rows
      .filter(m => m.keySource === 'enter' && m.name.trim() && m.apiKey.trim())
      .map(m => [m.name.trim(), m.apiKey.replace(/\s+/g, '')]),
  );
  return Object.keys(keys).length ? keys : undefined;
};

const ENDPOINT = /^https?:\/\/[^/:]+(:[0-9]+)?(\/.*)?$/;
const K8S_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const SECRET_KEY = /^[-._a-zA-Z0-9]+$/;

/** Errors per model row; mirrors the XRD's rules. */
export function validateModels(rows: ModelRow[]): Record<number, string> {
  const errors: Record<number, string> = {};
  const seen = new Set<string>();
  rows.forEach((m, i) => {
    if (!m.name.trim()) errors[i] = 'Give the model the name clients send.';
    else if (seen.has(m.name)) errors[i] = `Model ${m.name} is listed twice.`;
    else if (!ENDPOINT.test(m.endpoint)) errors[i] = 'The endpoint is a URL, e.g. https://api.openai.com/v1.';
    else if (m.keySource === 'enter' && !m.apiKey.trim()) errors[i] = "Enter the provider's API key, or pick another key source.";
    else if (m.keySource === 'secret' && !K8S_NAME.test(m.secretName)) errors[i] = 'The Secret name is a Kubernetes name, e.g. stackit.';
    // A pasted token passes the XRD's character rule (a JWT does), not this.
    else if (m.keySource === 'secret' && (!SECRET_KEY.test(m.secretKey) || m.secretKey.length > 63)) {
      errors[i] = 'The key in the Secret is a name like apiKey, not the token itself.';
    }
    seen.add(m.name);
  });
  return errors;
}

const SOURCES: Array<{ id: KeySource; label: string }> = [
  { id: 'enter', label: 'Enter the key (the portal stores it in a Secret)' },
  { id: 'secret', label: 'A Secret of my own in the project' },
  { id: 'none', label: 'None (an endpoint without auth, e.g. your own vLLM)' },
];

/** One model the gateway routes to. */
export const ModelFields = ({
  model,
  index,
  error,
  namespace,
  owner,
  onChange,
  onRemove,
}: {
  model: ModelRow;
  index: number;
  error?: string;
  namespace: string;
  /** The stack or gateway: names the Secret the portal writes the key into. */
  owner: string;
  onChange: (m: ModelRow) => void;
  onRemove: () => void;
}) => {
  const set = <K extends keyof ModelRow>(key: K) => (value: ModelRow[K]) => onChange({ ...model, [key]: value });
  const sources = model.keySource === 'stored' ? [{ id: 'stored' as const, label: 'Stored by the portal' }, ...SOURCES] : SOURCES;
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
          </Grid.Root>
          {model.keySource === 'enter' && (
            <Text variant="body-small" color="secondary">
              Stored in Secret <Mono>{providerKeySecretName(owner || '<name>', model.name.trim() || '<model>')}</Mono> in the
              project, never in the manifest; only the gateway reads it.
            </Text>
          )}
          {model.keySource === 'stored' && (
            <Text variant="body-small" color="secondary">
              The key is stored in Secret <Mono>{model.secretName}</Mono>. Pick "Enter the key" to replace it.
            </Text>
          )}
          {model.keySource === 'secret' && (
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
