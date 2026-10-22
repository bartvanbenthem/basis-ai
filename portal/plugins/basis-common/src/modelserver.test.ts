import { modelUriScheme, type ModelServer, serverGPUs, summarizeServer } from './modelserver';

describe('summarizeServer', () => {
  const server: ModelServer = {
    apiVersion: 'ai.cndev.nl/v1alpha1',
    kind: 'ModelServer',
    metadata: { name: 'llama', namespace: 'demo' },
    spec: { model: { uri: 'hf://meta-llama/Llama-3.1-8B-Instruct' }, replicas: 3, resources: { gpus: 2 }, recovery: { enabled: true, replicas: 1 } },
  };

  it('fills in the XRD defaults and KServe names before the composition reports', () => {
    const project = { spec: { locations: { protected: 'dc-a', recovery: 'dc-b' } } } as any;
    expect(summarizeServer(server, project)).toMatchObject({
      model: 'llama',
      gpus: 2,
      gpuResource: 'nvidia.com/gpu',
      prefixCacheAware: true,
      inferencePool: 'llama-inference-pool',
      endpoint: 'http://llama-kserve-workload-svc.demo.svc:8000/v1',
      sites: [
        { site: 'protected', location: 'dc-a', replicas: 3 },
        { site: 'recovery', location: 'dc-b', replicas: 1 },
      ],
    });
    expect(serverGPUs(summarizeServer(server))).toBe(8);
  });

  it('round robin without the scheduler; the served name from status', () => {
    const s = summarizeServer({
      ...server,
      spec: { ...server.spec, routing: { prefixCacheAware: false } },
      status: { model: 'meta-llama/Llama-3.1-8B-Instruct' },
    });
    expect(s.inferencePool).toBeUndefined();
    expect(s.model).toBe('meta-llama/Llama-3.1-8B-Instruct');
  });

  it('knows the URI schemes the XRD allows', () => {
    expect(modelUriScheme('pvc://models/x')).toBe('pvc');
    expect(modelUriScheme('https://huggingface.co/x')).toBeUndefined();
  });
});
