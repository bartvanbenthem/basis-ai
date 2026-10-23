import { claudeMcpAddCommand, clientTools, type MCPServer, mcpTools, summarizeMcpServer } from './mcpserver';

describe('summarizeMcpServer', () => {
  const server: MCPServer = {
    apiVersion: 'ai.cndev.nl/v1alpha1',
    kind: 'MCPServer',
    metadata: { name: 'kb', namespace: 'demo', labels: { 'backstage.io/owner': 'group:default/ai' } },
    spec: { database: { stack: 'support' }, recovery: { enabled: true } },
  };

  it('fills in the XRD defaults before the composition reports', () => {
    const project = { spec: { locations: { protected: 'dc-a', recovery: 'dc-b' } } } as any;
    expect(summarizeMcpServer(server, project)).toMatchObject({
      databaseKind: 'GenAIStack',
      database: 'support',
      mode: 'text',
      memoryScope: 'client',
      tools: ['search', 'fetch', 'remember', 'recall', 'forget'],
      clients: [{ name: 'agents' }],
      endpoint: 'http://kb.demo.svc/mcp',
      keysSecret: 'kb-keys',
      owner: 'group:default/ai',
      sites: [
        { site: 'protected', location: 'dc-a', active: true, replicas: 2 },
        { site: 'recovery', location: 'dc-b', active: false, replicas: 1 },
      ],
    });
  });

  it('hybrid with a model; a cluster with a table of your own; the status wins', () => {
    const s = summarizeMcpServer({
      ...server,
      spec: {
        database: { cluster: 'docs' },
        embeddings: { model: 'bge-m3', gateway: 'shared' },
        retrieval: { table: 'public.chunks' },
        memory: { enabled: false },
      },
      status: { activeSite: 'recovery', tools: ['search', 'fetch'], expiredClients: ['old'] },
    });
    expect(s).toMatchObject({ databaseKind: 'PostgresCluster', database: 'docs', mode: 'hybrid', table: 'public.chunks', memory: false });
    expect(s.tools).toEqual(['search', 'fetch']);
    expect(s.activeSite).toBe('recovery');
    expect(s.expiredClients).toEqual(['old']);
  });
});

describe('tools', () => {
  it('follows retrieval, ingest and memory', () => {
    expect(mcpTools({ database: {}, retrieval: { ingest: true }, memory: { enabled: false } })).toEqual([
      'search',
      'fetch',
      'add_document',
      'delete_document',
    ]);
    expect(mcpTools({ database: {}, retrieval: { enabled: false } })).toEqual(['remember', 'recall', 'forget']);
  });

  it('narrows to a client\'s list, only what is served', () => {
    expect(clientTools(['search', 'fetch', 'recall'], { name: 'bot', tools: ['search', 'forget'] })).toEqual(['search']);
    expect(clientTools(['search', 'fetch'], { name: 'all' })).toEqual(['search', 'fetch']);
  });

  it('connects Claude Code through a port-forward', () => {
    expect(claudeMcpAddCommand({ name: 'kb', namespace: 'demo' }, 'claude-code')).toEqual([
      'kubectl -n demo port-forward svc/kb 8080:80',
      'claude mcp add --transport http kb http://localhost:8080/mcp --header "Authorization: Bearer <claude-code\'s key>"',
    ]);
  });
});
