import type { MCPServer } from '@internal/backstage-plugin-basis-common';
import { defaultMcpForm, effectiveMode, formTools, fromMcpServer, toMcpEditPatch, toMcpSpec, validateMcp } from './mcpForm';

describe('mcpForm', () => {
  const form = { ...defaultMcpForm(), name: 'kb', namespace: 'demo', stack: 'support-bot' };

  it('maps onto the XRD: a stack, text search without a model', () => {
    expect(toMcpSpec(form)).toEqual({
      database: { stack: 'support-bot' },
      retrieval: { enabled: true, topK: 8, textSearchConfig: 'simple', ingest: false },
      memory: { enabled: true, scope: 'client' },
      clients: [{ name: 'agents' }],
      replicas: 2,
      resources: { cpu: '250m', memory: '256Mi' },
      recovery: { enabled: false, replicas: 1 },
      alerts: { disabled: false },
    });
    expect(effectiveMode(form)).toBe('text');
    expect(effectiveMode({ ...form, embeddingsModel: 'text-embedding-3-small' })).toBe('hybrid');
    expect(formTools({ ...form, ingest: true })).toEqual(['search', 'fetch', 'add_document', 'delete_document', 'remember', 'recall', 'forget']);
  });

  it('a cluster with a table of its own, embeddings through a gateway; clients with tools in the server\'s order', () => {
    const spec = toMcpSpec({
      ...form,
      databaseKind: 'cluster',
      cluster: 'docs',
      credentialsSecret: 'kb-reader',
      embeddingsModel: 'bge-m3',
      embeddingsGateway: 'shared',
      table: 'public.chunks',
      columns: { id: 'chunk_id', content: 'body', title: '', source: 'url', metadata: '', embedding: 'vec' },
      memory: false,
      clients: ['bot', ' '],
      clientSettings: { bot: { owner: 'team-ai', tools: ['fetch', 'search'], expiresAt: '2027-01-31' } },
    });
    expect(spec).toMatchObject({
      database: { cluster: 'docs', credentialsSecretRef: { name: 'kb-reader' } },
      embeddings: { model: 'bge-m3', gateway: 'shared' },
      retrieval: { table: 'public.chunks', columns: { id: 'chunk_id', content: 'body', source: 'url', embedding: 'vec' }, ingest: false },
      memory: { enabled: false },
      clients: [{ name: 'bot', owner: 'team-ai', tools: ['search', 'fetch'], expiresAt: '2027-01-31' }],
    });
    // A stack's gateway and client are the stack's.
    expect(toMcpSpec({ ...form, embeddingsModel: 'm', embeddingsGateway: 'shared' }).embeddings).toEqual({ model: 'm' });
  });

  it('mirrors the XRD rules', () => {
    const errors = validateMcp({
      ...defaultMcpForm(),
      name: 'Bad_Name',
      mode: 'vector',
      table: 'chunks',
      ingest: true,
      clients: ['a', 'a'],
      retentionDays: '0',
    });
    expect(Object.keys(errors).sort()).toEqual(['clients', 'ingest', 'mode', 'name', 'namespace', 'retentionDays', 'stack', 'table']);
    expect(validateMcp(form)).toEqual({});
    const cluster = { ...form, databaseKind: 'cluster' as const, cluster: 'docs', embeddingsModel: 'm', recovery: true };
    expect(Object.keys(validateMcp(cluster)).sort()).toEqual(['credentialsSecret', 'embeddingsGateway']);
    expect(validateMcp({ ...form, retrieval: false, memory: false }).memory).toBeDefined();
    expect(validateMcp({ ...form, clients: [] }).clients).toContain('At least one client');
  });

  it('round-trips a server and patches only what changed', () => {
    const server: MCPServer = {
      apiVersion: 'ai.cndev.nl/v1alpha1',
      kind: 'MCPServer',
      metadata: { name: 'kb', namespace: 'demo', labels: { 'backstage.io/owner': 'team-ai' } },
      spec: {
        database: { stack: 'support-bot' },
        embeddings: { model: 'text-embedding-3-small' },
        retrieval: { ingest: true, textSearchConfig: 'english' },
        memory: { scope: 'shared', retentionDays: 90 },
        clients: [{ name: 'claude-code', owner: 'me' }, { name: 'bot', tools: ['search', 'recall'] }],
        image: 'registry.local/basis-mcp:v1',
      },
    };
    const original = fromMcpServer(server);
    expect(original).toMatchObject({ owner: 'team-ai', embeddingsModel: 'text-embedding-3-small', ingest: true, memoryScope: 'shared', retentionDays: '90' });
    expect(toMcpEditPatch(original, original)).toEqual({});
    expect(toMcpEditPatch(original, { ...original, memoryScope: 'client', retentionDays: '' })).toEqual({
      memory: { scope: 'client', retentionDays: null },
    });
    // No model any more: the embeddings go.
    expect(toMcpEditPatch(original, { ...original, embeddingsModel: '' })).toEqual({ embeddings: null });
  });
});
