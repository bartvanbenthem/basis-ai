/**
 * Create/edit-MCP-server form state and its mapping onto an MCPServer spec.
 * Like the other forms: the fields mirror the XRD, which (with the admission
 * policy) has the final say.
 */

import {
  MCP_GROUP,
  MCP_KIND,
  MCP_TOOLS,
  MCP_VERSION,
  type MCPServer,
  type McpTool,
  type MemoryScope,
  type SearchMode,
} from '@internal/backstage-plugin-basis-common';
import { mergePatch } from './form';

export interface McpClientSettings {
  owner: string;
  /** The tools it may call; empty for all the server serves. */
  tools: McpTool[];
  /** YYYY-MM-DD, empty for none. */
  expiresAt: string;
}

export interface McpForm {
  name: string;
  namespace: string;
  owner: string;
  /** A stack's database (its role and gateway), or a cluster's. */
  databaseKind: 'stack' | 'cluster';
  stack: string;
  cluster: string;
  /** With a cluster: its database; empty for app. */
  databaseName: string;
  /** With a cluster: a basic-auth Secret of a role; empty for the owner (CNPG's <cluster>-app). */
  credentialsSecret: string;
  /** Empty: full-text search only. */
  embeddingsModel: string;
  /** With a cluster: the ModelGateway serving the model. */
  embeddingsGateway: string;
  /** The server's client there; empty for the server's name. */
  embeddingsClient: string;
  dimensions: string;
  retrieval: boolean;
  /** '' picks hybrid with a model, text without. */
  mode: '' | SearchMode;
  topK: number;
  textSearchConfig: string;
  ingest: boolean;
  /** A documents table of your own (schema.table); empty for the server's mcp.documents. */
  table: string;
  columns: { id: string; content: string; title: string; source: string; metadata: string; embedding: string };
  memory: boolean;
  memoryScope: MemoryScope;
  retentionDays: string;
  clients: string[];
  clientSettings: Record<string, McpClientSettings>;
  replicas: number;
  cpu: string;
  memoryLimit: string;
  recovery: boolean;
  recoveryReplicas: number;
  alerts: boolean;
}

export const emptyMcpClientSettings = (): McpClientSettings => ({ owner: '', tools: [], expiresAt: '' });

export const defaultMcpForm = (): McpForm => ({
  name: '',
  namespace: '',
  owner: '',
  databaseKind: 'stack',
  stack: '',
  cluster: '',
  databaseName: '',
  credentialsSecret: '',
  embeddingsModel: '',
  embeddingsGateway: '',
  embeddingsClient: '',
  dimensions: '',
  retrieval: true,
  mode: '',
  topK: 8,
  textSearchConfig: 'simple',
  ingest: false,
  table: '',
  columns: { id: 'id', content: 'content', title: '', source: '', metadata: '', embedding: '' },
  memory: true,
  memoryScope: 'client',
  retentionDays: '',
  clients: ['agents'],
  clientSettings: {},
  replicas: 2,
  cpu: '250m',
  memoryLimit: '256Mi',
  recovery: false,
  recoveryReplicas: 1,
  alerts: true,
});

export function fromMcpServer(server: MCPServer): McpForm {
  const { metadata, spec } = server;
  const d = defaultMcpForm();
  const cols = spec.retrieval?.columns ?? {};
  const clients = spec.clients ?? [{ name: 'agents' }];
  return {
    name: metadata.name,
    namespace: metadata.namespace,
    owner: metadata.labels?.['backstage.io/owner'] ?? '',
    databaseKind: spec.database.cluster ? 'cluster' : 'stack',
    stack: spec.database.stack ?? '',
    cluster: spec.database.cluster ?? '',
    databaseName: spec.database.name ?? '',
    credentialsSecret: spec.database.credentialsSecretRef?.name ?? '',
    embeddingsModel: spec.embeddings?.model ?? '',
    embeddingsGateway: spec.embeddings?.gateway ?? '',
    embeddingsClient: spec.embeddings?.client ?? '',
    dimensions: spec.embeddings?.dimensions ? String(spec.embeddings.dimensions) : '',
    retrieval: spec.retrieval?.enabled ?? true,
    mode: spec.retrieval?.mode ?? '',
    topK: spec.retrieval?.topK ?? d.topK,
    textSearchConfig: spec.retrieval?.textSearchConfig ?? d.textSearchConfig,
    ingest: Boolean(spec.retrieval?.ingest),
    table: spec.retrieval?.table ?? '',
    columns: {
      id: cols.id ?? 'id',
      content: cols.content ?? 'content',
      title: cols.title ?? '',
      source: cols.source ?? '',
      metadata: cols.metadata ?? '',
      embedding: cols.embedding ?? '',
    },
    memory: spec.memory?.enabled ?? true,
    memoryScope: spec.memory?.scope ?? 'client',
    retentionDays: spec.memory?.retentionDays ? String(spec.memory.retentionDays) : '',
    clients: clients.map(c => c.name),
    clientSettings: Object.fromEntries(
      clients.map(c => [c.name, { owner: c.owner ?? '', tools: c.tools ?? [], expiresAt: c.expiresAt ?? '' }]),
    ),
    replicas: spec.replicas ?? d.replicas,
    cpu: spec.resources?.cpu ?? d.cpu,
    memoryLimit: spec.resources?.memory ?? d.memoryLimit,
    recovery: Boolean(spec.recovery?.enabled),
    recoveryReplicas: spec.recovery?.replicas ?? d.recoveryReplicas,
    alerts: !spec.alerts?.disabled,
  };
}

const NAME = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const STACK = /^[a-z]([-a-z0-9]{0,26}[a-z0-9])?$/;
const CLIENT = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const K8S_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const TABLE = /^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WHOLE = /^[1-9][0-9]*$/;

export type McpErrors = Partial<Record<keyof McpForm, string>>;

const clientNames = (f: McpForm) => f.clients.map(c => c.trim()).filter(Boolean);

/** The search mode the server uses: the form's, else hybrid with a model, text without. */
export const effectiveMode = (f: McpForm): SearchMode => f.mode || (f.embeddingsModel.trim() ? 'hybrid' : 'text');

/** The tools the server serves for this form. */
export function formTools(f: McpForm): McpTool[] {
  const tools: McpTool[] = [];
  if (f.retrieval) {
    tools.push('search', 'fetch');
    if (f.ingest && !f.table.trim()) tools.push('add_document', 'delete_document');
  }
  if (f.memory) tools.push('remember', 'recall', 'forget');
  return tools;
}

/** Field-level errors shown inline; mirrors the XRD's rules. */
export function validateMcp(f: McpForm): McpErrors {
  const e: McpErrors = {};
  if (!NAME.test(f.name)) e.name = 'Lowercase letters, digits and "-", starting with a letter, max 40 characters.';
  if (!f.namespace) e.namespace = 'Pick the project the server belongs to.';
  if (f.owner && !/^[A-Za-z0-9][-A-Za-z0-9_.]{0,62}$/.test(f.owner)) e.owner = 'A group name, e.g. team-payments.';
  const model = f.embeddingsModel.trim();
  if (f.databaseKind === 'stack') {
    if (!STACK.test(f.stack)) e.stack = 'Pick the GenAI stack whose database to use.';
  } else {
    if (!NAME.test(f.cluster)) e.cluster = 'Pick the PostgreSQL cluster whose database to use.';
    if (f.databaseName && !IDENT.test(f.databaseName)) e.databaseName = 'A database name, e.g. app.';
    if (f.credentialsSecret && !K8S_NAME.test(f.credentialsSecret)) e.credentialsSecret = 'A Secret name in the project.';
    if (f.recovery && !f.credentialsSecret) {
      e.credentialsSecret = 'With the recovery site, a role of the cluster (spec.roles) with its basic-auth Secret: the same in both sites.';
    }
    if (model && !NAME.test(f.embeddingsGateway)) e.embeddingsGateway = 'The model gateway serving the embeddings model.';
    if (f.embeddingsClient && !CLIENT.test(f.embeddingsClient)) e.embeddingsClient = 'A client name: lowercase letters, digits and "-".';
  }
  if (model.length > 200) e.embeddingsModel = 'At most 200 characters.';
  if (f.dimensions && (!WHOLE.test(f.dimensions) || Number(f.dimensions) > 16000)) e.dimensions = '1 to 16000, or empty for the model\'s own.';
  if (f.mode && f.mode !== 'text' && !model) e.mode = `${f.mode} search needs an embeddings model.`;
  if (!Number.isInteger(f.topK) || f.topK < 1 || f.topK > 50) e.topK = '1 to 50';
  if (!IDENT.test(f.textSearchConfig)) e.textSearchConfig = 'A PostgreSQL text search configuration, e.g. simple or english.';
  if (f.table) {
    if (!TABLE.test(f.table)) e.table = 'schema.table, lowercase, e.g. public.chunks.';
    if (f.ingest) e.ingest = 'A table of your own is only read; ingest writes the server\'s own.';
    const bad = Object.entries(f.columns).find(([k, v]) => (v || k === 'id' || k === 'content') && !IDENT.test(v));
    if (bad) e.columns = `Column ${bad[0]}: a column name.`;
  }
  if (!f.retrieval && !f.memory) e.memory = 'Serve retrieval, memory or both.';
  if (f.retentionDays && (!WHOLE.test(f.retentionDays) || Number(f.retentionDays) > 3650)) e.retentionDays = '1 to 3650 days, or empty to keep them.';
  const clients = clientNames(f);
  const bad = clients.find(c => !CLIENT.test(c));
  if (bad) e.clients = `Client ${bad}: lowercase letters, digits and "-".`;
  else if (new Set(clients).size !== clients.length) e.clients = 'A client is listed twice.';
  else if (clients.length === 0) e.clients = 'At least one client: whoever has no key can\'t call the server.';
  for (const c of clients) {
    const s = f.clientSettings[c];
    if (s?.expiresAt && !DATE.test(s.expiresAt)) e.clientSettings = `Client ${c}: expires as YYYY-MM-DD.`;
    else if (s?.owner && s.owner.length > 100) e.clientSettings = `Client ${c}: the owner is at most 100 characters.`;
  }
  if (!Number.isInteger(f.replicas) || f.replicas < 1 || f.replicas > 10) e.replicas = '1 to 10';
  if (!/^[0-9]+(\.[0-9]+)?m?$/.test(f.cpu)) e.cpu = 'e.g. 250m or 1';
  if (!/^[0-9]+(Mi|Gi)$/.test(f.memoryLimit)) e.memoryLimit = 'e.g. 256Mi';
  if (!Number.isInteger(f.recoveryReplicas) || f.recoveryReplicas < 0 || f.recoveryReplicas > 10) e.recoveryReplicas = '0 to 10';
  return e;
}

export function toMcpSpec(f: McpForm): Record<string, unknown> {
  const model = f.embeddingsModel.trim();
  const cluster = f.databaseKind === 'cluster';
  const database = cluster
    ? {
        cluster: f.cluster,
        ...(f.databaseName ? { name: f.databaseName } : {}),
        ...(f.credentialsSecret ? { credentialsSecretRef: { name: f.credentialsSecret } } : {}),
      }
    : { stack: f.stack };
  const embeddings = model
    ? {
        model,
        ...(f.dimensions ? { dimensions: Number(f.dimensions) } : {}),
        ...(cluster && f.embeddingsGateway ? { gateway: f.embeddingsGateway } : {}),
        ...(cluster && f.embeddingsClient ? { client: f.embeddingsClient } : {}),
      }
    : undefined;
  const table = f.table.trim();
  const columns = Object.fromEntries(Object.entries(f.columns).filter(([, v]) => v.trim()));
  return {
    database,
    ...(embeddings ? { embeddings } : {}),
    retrieval: {
      enabled: f.retrieval,
      ...(f.mode ? { mode: f.mode } : {}),
      topK: f.topK,
      textSearchConfig: f.textSearchConfig,
      ingest: f.ingest && !table,
      ...(table ? { table, columns } : {}),
    },
    memory: {
      enabled: f.memory,
      scope: f.memoryScope,
      ...(f.retentionDays ? { retentionDays: Number(f.retentionDays) } : {}),
    },
    clients: clientNames(f).map(name => {
      const s = f.clientSettings[name] ?? emptyMcpClientSettings();
      // In the server's order, whatever order they were picked in.
      const tools = MCP_TOOLS.filter(t => s.tools.includes(t));
      return {
        name,
        ...(s.owner.trim() ? { owner: s.owner.trim() } : {}),
        ...(tools.length ? { tools } : {}),
        ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}),
      };
    }),
    replicas: f.replicas,
    resources: { cpu: f.cpu, memory: f.memoryLimit },
    recovery: { enabled: f.recovery, replicas: f.recoveryReplicas },
    alerts: { disabled: !f.alerts },
  };
}

export function toMcpManifest(f: McpForm) {
  return {
    apiVersion: `${MCP_GROUP}/${MCP_VERSION}`,
    kind: MCP_KIND,
    metadata: {
      name: f.name || '<name>',
      namespace: f.namespace || '<project>',
      ...(f.owner ? { labels: { 'backstage.io/owner': f.owner } } : {}),
    },
    spec: toMcpSpec(f),
  };
}

/** What an edit changes: a merge patch, empty when nothing changed. The clients list is replaced as a whole. */
export function toMcpEditPatch(original: McpForm, f: McpForm): Record<string, unknown> {
  return (mergePatch(toMcpSpec(original), toMcpSpec(f)) ?? {}) as Record<string, unknown>;
}

/** The server's MCP endpoint for the form, for the descriptions. */
export const formEndpoint = (f: McpForm) => `http://${f.name || '<name>'}.${f.namespace || '<project>'}.svc/mcp`;
