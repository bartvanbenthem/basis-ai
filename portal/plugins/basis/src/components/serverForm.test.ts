import type { ModelServer } from '@internal/backstage-plugin-basis-common';
import { defaultServerForm, fromServer, servedName, toServerEditPatch, toServerSpec, validateServer } from './serverForm';

describe('serverForm', () => {
  const form = { ...defaultServerForm(), name: 'llama', namespace: 'demo', uri: 'hf://meta-llama/Llama-3.1-8B-Instruct' };

  it('maps onto the XRD, leaving the defaults to it where the form has none', () => {
    expect(toServerSpec({ ...form, tokenSecret: 'hf-token', args: '--max-model-len=8192\n\n--enforce-eager', tolerations: 'nvidia.com/gpu' })).toEqual({
      model: { uri: 'hf://meta-llama/Llama-3.1-8B-Instruct', tokenSecretRef: { name: 'hf-token' } },
      replicas: 1,
      resources: { cpu: '4', memory: '16Gi', gpus: 1, gpuResource: 'nvidia.com/gpu' },
      args: ['--max-model-len=8192', '--enforce-eager'],
      routing: { prefixCacheAware: true },
      scheduling: { tolerations: [{ key: 'nvidia.com/gpu', operator: 'Exists' }] },
      recovery: { enabled: false, replicas: 1 },
      alerts: { disabled: false },
    });
    expect(servedName(form)).toBe('llama');
    expect(servedName({ ...form, servedName: 'meta-llama/Llama-3.1-8B-Instruct' })).toBe('meta-llama/Llama-3.1-8B-Instruct');
  });

  it('mirrors the XRD rules', () => {
    const errors = validateServer({
      ...defaultServerForm(),
      name: 'Bad_Name',
      uri: 'https://huggingface.co/x',
      replicas: 21,
      gpus: 0,
      memory: '16G',
      args: '--max-model-len 8192',
      nodeSelector: 'gpu',
    });
    expect(Object.keys(errors).sort()).toEqual(['args', 'image', 'memory', 'name', 'namespace', 'nodeSelector', 'replicas', 'uri']);
    expect(errors.image).toContain('vllm-openai-cpu');
    expect(validateServer(form)).toEqual({});
    expect(validateServer({ ...form, gpus: 0, image: 'vllm/vllm-openai-cpu:v0.23.0' })).toEqual({});
  });

  it('round-trips a server and patches only what changed', () => {
    const server: ModelServer = {
      apiVersion: 'ai.cndev.nl/v1alpha1',
      kind: 'ModelServer',
      metadata: { name: 'llama', namespace: 'demo', labels: { 'backstage.io/owner': 'team-ai' } },
      spec: {
        model: { uri: 'pvc://models/llama', name: 'llama-3.1' },
        replicas: 2,
        resources: { gpus: 2 },
        scheduling: { nodeSelector: { gpu: 'h100' }, tolerations: [{ key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' }] },
        recovery: { enabled: true, replicas: 0 },
      },
    };
    const original = fromServer(server);
    expect(original).toMatchObject({ owner: 'team-ai', servedName: 'llama-3.1', replicas: 2, gpus: 2, nodeSelector: 'gpu=h100', tolerations: 'nvidia.com/gpu', recovery: true, recoveryReplicas: 0 });
    expect(toServerEditPatch(original, original)).toEqual({});
    expect(toServerEditPatch(original, { ...original, replicas: 0, image: 'rocm/vllm:latest' })).toEqual({ replicas: 0, image: 'rocm/vllm:latest' });
    expect(toServerEditPatch({ ...original, image: 'rocm/vllm:latest' }, original)).toEqual({ image: null });
  });
});
