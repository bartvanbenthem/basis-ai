import { Button, Card, CardBody, Flex, Grid, Select, Text, TextField } from '@backstage/ui';
import { MODEL_SCHEMAS, type GatewayModel, type ModelSchema } from '@internal/backstage-plugin-basis-common';
import { Mono } from './common';

/** One model row of a gateway form; the Secret holds the provider's key. */
export interface ModelRow {
  name: string;
  endpoint: string;
  schema: ModelSchema;
  upstreamModel: string;
  /** Secret in the project namespace with the provider's key; empty for none. */
  secretName: string;
  secretKey: string;
}

export const emptyModel = (): ModelRow => ({
  name: '',
  endpoint: '',
  schema: 'OpenAI',
  upstreamModel: '',
  secretName: '',
  secretKey: 'apiKey',
});

export const fromModel = (m: GatewayModel): ModelRow => ({
  name: m.name,
  endpoint: m.endpoint,
  schema: m.schema ?? 'OpenAI',
  upstreamModel: m.upstreamModel ?? '',
  secretName: m.apiKeySecretRef?.name ?? '',
  secretKey: m.apiKeySecretRef?.key ?? 'apiKey',
});

export const toModels = (rows: ModelRow[]) =>
  rows
    .filter(m => m.name.trim())
    .map(m => ({
      name: m.name.trim(),
      endpoint: m.endpoint.trim(),
      schema: m.schema,
      ...(m.upstreamModel.trim() ? { upstreamModel: m.upstreamModel.trim() } : {}),
      ...(m.secretName.trim() ? { apiKeySecretRef: { name: m.secretName.trim(), key: m.secretKey.trim() || 'apiKey' } } : {}),
    }));

const ENDPOINT = /^https?:\/\/[^/:]+(:[0-9]+)?(\/.*)?$/;
const K8S_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

/** Errors per model row; mirrors the XRD's rules. */
export function validateModels(rows: ModelRow[]): Record<number, string> {
  const errors: Record<number, string> = {};
  const seen = new Set<string>();
  rows.forEach((m, i) => {
    if (!m.name.trim()) errors[i] = 'Give the model the name clients send.';
    else if (seen.has(m.name)) errors[i] = `Model ${m.name} is listed twice.`;
    else if (!ENDPOINT.test(m.endpoint)) errors[i] = 'The endpoint is a URL, e.g. https://api.openai.com/v1.';
    else if (m.secretName && !K8S_NAME.test(m.secretName)) errors[i] = 'The Secret name is a Kubernetes name.';
    seen.add(m.name);
  });
  return errors;
}

/** One model the gateway routes to. */
export const ModelFields = ({
  model,
  index,
  error,
  namespace,
  onChange,
  onRemove,
}: {
  model: ModelRow;
  index: number;
  error?: string;
  namespace: string;
  onChange: (m: ModelRow) => void;
  onRemove: () => void;
}) => {
  const set = <K extends keyof ModelRow>(key: K) => (value: ModelRow[K]) => onChange({ ...model, [key]: value });
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
              description="What clients send as model, e.g. gpt-4o-mini."
            />
            <Select
              label="API"
              value={model.schema}
              onChange={k => set('schema')((k as ModelSchema) ?? 'OpenAI')}
              options={MODEL_SCHEMAS.map(s => ({ id: s, label: s === 'OpenAI' ? 'OpenAI (and OpenAI-compatible: vLLM, KServe, Ollama, ...)' : s }))}
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
              description="When it differs from the model name, e.g. meta-llama/Llama-3.1-8B-Instruct."
            />
            <TextField
              label="API key Secret"
              value={model.secretName}
              onChange={set('secretName')}
              description={`A Secret in project ${namespace || '<project>'}; empty for an endpoint without auth.`}
            />
            <TextField label="Key in the Secret" value={model.secretKey} onChange={set('secretKey')} />
          </Grid.Root>
          {model.secretName && (
            <Text variant="body-small" color="secondary">
              Create it once on the control plane:{' '}
              <Mono>
                kubectl -n {namespace || '<project>'} create secret generic {model.secretName} --from-literal=
                {model.secretKey || 'apiKey'}=...
              </Mono>
            </Text>
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

