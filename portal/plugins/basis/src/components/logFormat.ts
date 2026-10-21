/**
 * Turns CNPG's JSON log lines into readable, ANSI-coloured text for the
 * LogViewer. The instance manager logs one JSON object per line:
 *
 *   {"level":"info","ts":"...","logger":"postgres","msg":"record","logging_pod":"db-1",
 *    "record":{"error_severity":"LOG","user_name":"app","database_name":"app","message":"..."}}
 *
 * PostgreSQL's own log entries are the ones with a `record`; everything else
 * (WAL archiving, the instance manager) carries its details as extra fields.
 * Lines that aren't JSON are passed through unchanged.
 */

// Only codes Backstage's LogViewer (AnsiProcessor) understands: it ignores
// \x1b[0m and \x1b[2m, so a "reset" would leave every following line coloured.
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[90m';
const RESET = '\x1b[39m';

/** Fields every line has, or that only repeat what the tab already shows. */
const COMMON = new Set(['level', 'ts', 'logger', 'msg', 'logging_pod', 'caller', 'record']);
/** Record fields that add something to the message when present. */
const RECORD_EXTRAS = ['detail', 'hint', 'context', 'query', 'statement'];

function color(level: string): string {
  const l = level.toUpperCase();
  if (['ERROR', 'FATAL', 'PANIC', 'DPANIC'].includes(l)) return RED;
  if (['WARNING', 'WARN'].includes(l)) return YELLOW;
  if (l.startsWith('DEBUG')) return DIM;
  return '';
}

function timestamp(ts: unknown): string {
  if (typeof ts === 'number') return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 23);
  if (typeof ts === 'string') return ts.replace('T', ' ').slice(0, 23);
  return '';
}

function value(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export function formatLogLine(line: string): string {
  if (!line.startsWith('{')) return line;
  let entry: Record<string, any>;
  try {
    entry = JSON.parse(line);
  } catch {
    return line;
  }
  if (!entry || typeof entry !== 'object') return line;

  const record = entry.record && typeof entry.record === 'object' ? entry.record : undefined;
  const level = String(record?.error_severity ?? entry.level ?? '');
  const c = color(level);
  const head = [
    timestamp(entry.ts),
    `${c}${level.toUpperCase().padEnd(7)}${c ? RESET : ''}`,
    `${DIM}${entry.logger ?? ''}${RESET}`,
  ];

  let body: string;
  if (record) {
    const who =
      record.user_name || record.database_name
        ? `${record.user_name ?? ''}@${record.database_name ?? ''} `
        : '';
    const extras = RECORD_EXTRAS.filter(k => record[k]).map(k => `${k}: ${value(record[k])}`);
    body = [`${who}${record.message ?? ''}`, ...extras].join(' | ');
  } else {
    const extras = Object.keys(entry)
      .filter(k => !COMMON.has(k))
      .map(k => `${k}=${value(entry[k])}`);
    body = [entry.msg ?? '', ...extras].filter(Boolean).join(' ');
  }
  return `${head.join(' ')} ${c}${body}${c ? RESET : ''}`;
}

export function formatLogs(text: string): string {
  return text
    .split('\n')
    .map(formatLogLine)
    .join('\n');
}
