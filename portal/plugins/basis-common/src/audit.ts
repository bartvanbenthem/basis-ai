/**
 * A project's audit trail, as the Audit logs page shows it:
 *
 * - kubernetes: the Events in the project's namespace on the control plane
 *   (Project, PostgresCluster XRs, Crossplane) and in every location it uses
 *   (CNPG Clusters, pods, volumes, backups), plus those of the cluster-scoped
 *   Project itself. The API server keeps them for about an hour.
 * - postgresql: pgaudit's records (statement classes picked with the
 *   pgaudit.log parameter) from the stdout of each PostgreSQL instance.
 *   CloudNativePG loads pgaudit as soon as a pgaudit.* parameter is set and
 *   logs its records as JSON lines with logger "pgaudit".
 * - gateway: the calls through the project's ModelGateways (their Envoy
 *   access logs: client, model, tokens, outcome).
 * - mcp: the tool calls on the project's MCPServers (basis-mcp's stdout:
 *   client, tool, outcome; never the query or the content).
 */
export type AuditSource = 'kubernetes' | 'postgresql' | 'gateway' | 'mcp';

/** Where control-plane events come from, in the location column. */
export const CONTROL_PLANE = 'control-plane';

export interface AuditEntry {
  source: AuditSource;
  /** RFC 3339. */
  time?: string;
  /** The location (Kubernetes cluster) it happened in, or "control-plane". */
  location: string;
  /** The PostgresCluster it concerns, when known. */
  cluster?: string;
  /** Who: the reporting controller (kubernetes), or user@database (postgresql). */
  actor?: string;
  /** What: the event reason, or the SQL command (CREATE TABLE, GRANT...). */
  action: string;
  /** On what: Kind/name, or the SQL object (public.orders). */
  object?: string;
  /** The event's message, or the statement. */
  message: string;
  /** kubernetes: Normal or Warning. postgresql: pgaudit's class (READ, WRITE, DDL, ROLE...). */
  type: string;
  /** How often a kubernetes event repeated. */
  count?: number;
  /** postgresql: the instance (pod) that logged it. */
  instance?: string;
  /** postgresql: the client address (connection_from). gateway: the caller's address. */
  client?: string;
  /** gateway: the ModelGateway that served it. */
  gateway?: string;
  /** gateway: the request's tokens, input and output. */
  tokens?: { input?: number; output?: number };
  /** mcp: the MCPServer that served it. */
  mcpServer?: string;
}

/** A PostgresCluster in the project and whether pgaudit records anything for it. */
export interface AuditedCluster {
  name: string;
  /** spec.postgresql.parameters["pgaudit.log"], or the size's; unset when pgaudit is off. */
  pgauditLog?: string;
}

export interface AuditLog {
  project: string;
  items: AuditEntry[];
  clusters: AuditedCluster[];
  /** Locations, or instances, whose entries couldn't be read. */
  unreachable?: Array<{ location: string; message: string }>;
}

/** What pgaudit.log is set to for a cluster, explicitly or by its size; undefined when off. */
export function pgauditLog(parameters?: Record<string, unknown>): string | undefined {
  const value = parameters?.['pgaudit.log'];
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return v && v.toLowerCase() !== 'none' ? v : undefined;
}

/** "2026-10-07 09:12:03.123 UTC" (PostgreSQL's log_time) as RFC 3339. */
function logTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?) UTC$/.exec(value);
  return m ? `${m[1]}T${m[2]}Z` : undefined;
}

function zapTime(ts: unknown): string | undefined {
  if (typeof ts === 'number') return new Date(ts * 1000).toISOString();
  if (typeof ts === 'string' && ts) return ts;
  return undefined;
}

const text = (v: unknown) => (typeof v === 'string' && v && v !== '<none>' && v !== '<not logged>' ? v : undefined);

/**
 * One pgaudit record from a line of a CNPG instance's stdout; undefined for
 * every other line. The line looks like:
 *
 *   {"level":"info","ts":"...","logger":"pgaudit","msg":"record","logging_pod":"db-1",
 *    "record":{"log_time":"... UTC","user_name":"app","database_name":"app",
 *      "connection_from":"10.0.0.7:51234","audit":{"audit_type":"SESSION",
 *      "class":"DDL","command":"CREATE TABLE","object_type":"TABLE",
 *      "object_name":"public.orders","statement":"CREATE TABLE orders (...)"}}}
 */
export function parsePgAuditLine(
  line: string,
): Omit<AuditEntry, 'location' | 'cluster'> | undefined {
  if (!line.startsWith('{') || !line.includes('"pgaudit"')) return undefined;
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (entry?.logger !== 'pgaudit' || typeof entry.record !== 'object' || !entry.record) return undefined;
  const record = entry.record;
  const audit = typeof record.audit === 'object' && record.audit ? record.audit : {};
  const user = text(record.user_name);
  const database = text(record.database_name);
  return {
    source: 'postgresql',
    time: logTime(record.log_time) ?? zapTime(entry.ts),
    actor: user || database ? `${user ?? ''}@${database ?? ''}` : undefined,
    action: text(audit.command) ?? text(record.command_tag) ?? 'statement',
    object: text(audit.object_name) ?? text(audit.object_type),
    message: text(audit.statement) ?? text(record.message) ?? '',
    type: text(audit.class) ?? text(audit.audit_type) ?? 'AUDIT',
    instance: text(entry.logging_pod),
    client: text(record.connection_from),
  };
}

const num = (v: unknown) => {
  let n = NaN;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v !== '' && v !== '-') n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * One line of a ModelGateway's access log (the JSON its Envoy writes, field
 * "basis": "gateway"): who called which model, with how many tokens and how
 * it ended. Never the prompt. Undefined for any other line.
 */
export function parseGatewayLine(line: string): AuditEntry | undefined {
  if (!line.includes('"basis":"gateway"') && !line.includes('"basis": "gateway"')) return undefined;
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (r.basis !== 'gateway') return undefined;
  // Envoy writes "-" for what it doesn't have.
  const s = (v: unknown) => (v === '-' ? undefined : text(v));
  const status = num(r.status);
  const input = num(r.input_tokens);
  const output = num(r.output_tokens);
  const tokens = input !== undefined || output !== undefined ? `${input ?? 0} + ${output ?? 0} tokens, ` : '';
  const details = s(r.details) && r.details !== 'via_upstream' ? ` (${r.details})` : '';
  return {
    source: 'gateway',
    time: s(r.time),
    location: '',
    actor: s(r.client) ?? 'unauthenticated',
    action: `${s(r.method) ?? ''} ${s(r.path) ?? ''}`.trim(),
    object: s(r.model),
    message: `${status ?? '-'}${details}, ${tokens}${num(r.duration_ms) ?? '-'} ms`,
    type: status === undefined ? 'unknown' : `${Math.floor(status / 100)}xx`,
    client: s(r.source),
    ...(input !== undefined || output !== undefined ? { tokens: { input, output } } : {}),
  };
}

/**
 * One line of an MCPServer's audit log (basis-mcp's stdout, field "basis":
 * "mcp"): which client called which tool and how it went, with the id of the
 * document or memory it touched. Never the query or the content. Undefined
 * for any other line.
 */
export function parseMcpLine(line: string): AuditEntry | undefined {
  if (!line.includes('"basis":"mcp"')) return undefined;
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (r.basis !== 'mcp') return undefined;
  const outcome = text(r.outcome) ?? 'unknown';
  const results = num(r.results);
  const parts = [
    outcome,
    ...(results !== undefined ? [`${results} result(s)`] : []),
    `${num(r.duration_ms) ?? '-'} ms`,
    ...(text(r.error) ? [text(r.error) as string] : []),
  ];
  return {
    source: 'mcp',
    time: text(r.time),
    location: '',
    actor: text(r.client) ?? 'unknown',
    action: text(r.tool) ?? 'tool',
    object: text(r.id),
    message: parts.join(', '),
    type: outcome,
    mcpServer: text(r.server),
  };
}
