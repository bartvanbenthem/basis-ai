/**
 * Shapes of the ai.cndev.nl/v1alpha1 MCPServer API served by api/
 * (apis/mcpserver): an MCP server with retrieval and agent memory over a
 * Project's database, basis-mcp. The XRD is the source of truth; these types
 * only cover what the portal reads or sends.
 */

import type { ClusterEvent, Condition, InstancePod, Project, Site } from './types';

export const MCP_GROUP = 'ai.cndev.nl';
export const MCP_VERSION = 'v1alpha1';
export const MCP_PLURAL = 'mcpservers';
export const MCP_KIND = 'MCPServer';

/** Annotation on catalog Resource entities: "<namespace>/<name>" of their MCPServer. */
export const MCP_ANNOTATION = 'ai.cndev.nl/mcpserver';

/** The tools basis-mcp serves, in the order it lists them. */
export const MCP_TOOLS = ['search', 'fetch', 'add_document', 'delete_document', 'remember', 'recall', 'forget'] as const;
export type McpTool = (typeof MCP_TOOLS)[number];

export const MCP_TOOL_INFO: Record<McpTool, { group: 'retrieval' | 'ingest' | 'memory'; description: string }> = {
  search: { group: 'retrieval', description: 'Search the knowledge base (hybrid: vectors and full text)' },
  fetch: { group: 'retrieval', description: 'A whole document by its id' },
  add_document: { group: 'ingest', description: 'Add a document (retrieval.ingest)' },
  delete_document: { group: 'ingest', description: 'Remove a document (retrieval.ingest)' },
  remember: { group: 'memory', description: 'Store a memory for later conversations' },
  recall: { group: 'memory', description: 'The memories most relevant to a query' },
  forget: { group: 'memory', description: 'Delete a memory' },
};

export const SEARCH_MODES = ['hybrid', 'vector', 'text'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export const MEMORY_SCOPES = ['client', 'shared'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export interface McpClient {
  name: string;
  /** Who to ask about the key. */
  owner?: string;
  /** The tools it may call; all the server serves when unset. */
  tools?: McpTool[];
  /** The key's last day (YYYY-MM-DD). */
  expiresAt?: string;
}

export interface MCPServerSpec {
  /** A GenAIStack's database, or a PostgresCluster's: one of them. */
  database: {
    stack?: string;
    cluster?: string;
    /** With a cluster: its database, app by default. */
    name?: string;
    /** With a cluster: a basic-auth Secret of one of its roles. */
    credentialsSecretRef?: { name: string };
  };
  embeddings?: { model?: string; dimensions?: number; gateway?: string; client?: string };
  retrieval?: {
    enabled?: boolean;
    /** A documents table of your own (schema.table), only read; mcp.documents by default. */
    table?: string;
    columns?: { id?: string; content?: string; title?: string; source?: string; metadata?: string; embedding?: string };
    mode?: SearchMode;
    topK?: number;
    textSearchConfig?: string;
    ingest?: boolean;
  };
  memory?: { enabled?: boolean; scope?: MemoryScope; retentionDays?: number };
  clients?: McpClient[];
  replicas?: number;
  resources?: { cpu?: string; memory?: string };
  recovery?: { enabled?: boolean; replicas?: number };
  image?: string;
  alerts?: { errorRatePercent?: number; latencySeconds?: number; disabled?: boolean };
}

export interface McpSiteStatus {
  site: Site;
  location: string;
  active?: boolean;
  replicas?: number;
  ready?: boolean;
}

export interface MCPServer {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
  };
  spec: MCPServerSpec;
  status?: {
    ready?: boolean;
    message?: string;
    activeSite?: Site;
    endpoint?: string;
    keysSecret?: string;
    clients?: number;
    tools?: McpTool[];
    toolCount?: number;
    /** GenAIStack/<name> or PostgresCluster/<name>. */
    database?: string;
    dashboardUid?: string;
    expiredClients?: string[];
    sites?: McpSiteStatus[];
    conditions?: Condition[];
  };
}

/** One row in the portal's MCP server list. */
export interface MCPServerSummary {
  name: string;
  namespace: string;
  databaseKind: 'GenAIStack' | 'PostgresCluster';
  /** The stack's or the cluster's name. */
  database: string;
  embeddingsModel?: string;
  /** The gateway the embeddings come from: the stack's (unknown here) or spec.embeddings.gateway. */
  embeddingsGateway?: string;
  mode: SearchMode;
  /** A documents table of your own, if any; the server's mcp.documents otherwise. */
  table?: string;
  retrieval: boolean;
  ingest: boolean;
  memory: boolean;
  memoryScope: MemoryScope;
  retentionDays?: number;
  tools: McpTool[];
  clients: McpClient[];
  expiredClients: string[];
  replicas: number;
  recovery: boolean;
  recoveryReplicas: number;
  activeSite: Site;
  endpoint: string;
  keysSecret: string;
  ready: boolean;
  synced: boolean;
  deleting: boolean;
  message?: string;
  owner?: string;
  sites: McpSiteStatus[];
  dashboardUid?: string;
  createdAt?: string;
  project?: string;
  grafanaUrl?: string;
}

/** The detail page: the server, its pods and events in its sites' locations. */
export interface MCPServerDetails {
  summary: MCPServerSummary;
  resource: MCPServer;
  pods: InstancePod[];
  events: ClusterEvent[];
  /** Set when a location's pods and events couldn't be read. */
  unreachable?: string;
}

/** A client's API key, as the keys endpoint hands it out. */
export interface McpKey {
  client: string;
  key: string;
}

/** The MCP endpoint of a server, the same in every site's location. */
export const mcpEndpoint = (name: string, namespace: string) => `http://${name}.${namespace}.svc/mcp`;

/** The server's pods. */
export const mcpLabelSelector = (name: string) => `app.kubernetes.io/name=basis-mcp,ai.cndev.nl/mcpserver=${name}`;

/** The tools a server serves for its spec (what the composition reports in status.tools). */
export function mcpTools(spec: MCPServerSpec): McpTool[] {
  const tools: McpTool[] = [];
  if (spec.retrieval?.enabled ?? true) {
    tools.push('search', 'fetch');
    if (spec.retrieval?.ingest) tools.push('add_document', 'delete_document');
  }
  if (spec.memory?.enabled ?? true) tools.push('remember', 'recall', 'forget');
  return tools;
}

/** The tools a client may call: the server's, narrowed to its list. */
export const clientTools = (served: McpTool[], client: McpClient): McpTool[] =>
  client.tools?.length ? served.filter(t => client.tools!.includes(t)) : served;

export function summarizeMcpServer(server: MCPServer, project?: Project): MCPServerSummary {
  const { metadata, spec, status } = server;
  const condition = (type: string) => status?.conditions?.find(c => c.type === type)?.status === 'True';
  const recovery = Boolean(spec.recovery?.enabled);
  const replicas = spec.replicas ?? 2;
  const recoveryReplicas = spec.recovery?.replicas ?? 1;
  const activeSite: Site = status?.activeSite ?? 'protected';
  const sites: McpSiteStatus[] =
    status?.sites ??
    (['protected', ...(recovery ? ['recovery'] : [])] as Site[]).map(site => ({
      site,
      location: project?.spec.locations?.[site] ?? '',
      active: site === activeSite,
      replicas: site === activeSite ? replicas : recoveryReplicas,
    }));
  const model = spec.embeddings?.model || undefined;
  return {
    name: metadata.name,
    namespace: metadata.namespace,
    databaseKind: spec.database.cluster ? 'PostgresCluster' : 'GenAIStack',
    database: spec.database.cluster ?? spec.database.stack ?? '',
    embeddingsModel: model,
    embeddingsGateway: spec.embeddings?.gateway || undefined,
    mode: spec.retrieval?.mode ?? (model ? 'hybrid' : 'text'),
    table: spec.retrieval?.table || undefined,
    retrieval: spec.retrieval?.enabled ?? true,
    ingest: Boolean(spec.retrieval?.ingest),
    memory: spec.memory?.enabled ?? true,
    memoryScope: spec.memory?.scope ?? 'client',
    retentionDays: spec.memory?.retentionDays,
    tools: status?.tools ?? mcpTools(spec),
    clients: spec.clients ?? [{ name: 'agents' }],
    expiredClients: status?.expiredClients ?? [],
    replicas,
    recovery,
    recoveryReplicas,
    activeSite,
    endpoint: status?.endpoint || mcpEndpoint(metadata.name, metadata.namespace),
    keysSecret: status?.keysSecret || `${metadata.name}-keys`,
    ready: condition('Ready'),
    synced: condition('Synced'),
    deleting: Boolean(metadata.deletionTimestamp),
    message: status?.message,
    owner: metadata.labels?.['backstage.io/owner'],
    sites,
    dashboardUid: status?.dashboardUid || undefined,
    createdAt: metadata.creationTimestamp,
  };
}

/**
 * The command that adds the server to Claude Code, through a port-forward
 * of its Service (it's internal to its location).
 */
export function claudeMcpAddCommand(server: Pick<MCPServerSummary, 'name' | 'namespace'>, client: string, port = 8080): string[] {
  return [
    `kubectl -n ${server.namespace} port-forward svc/${server.name} ${port}:80`,
    `claude mcp add --transport http ${server.name} http://localhost:${port}/mcp --header "Authorization: Bearer <${client}'s key>"`,
  ];
}
