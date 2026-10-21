import { formatLogLine, formatLogs } from './logFormat';

// Strip ANSI colours so the assertions read like the screen.
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('formatLogLine', () => {
  it('formats PostgreSQL records with user, database and extras', () => {
    const line = JSON.stringify({
      level: 'info',
      ts: '2026-10-07T09:00:00.123456789Z',
      logger: 'postgres',
      msg: 'record',
      logging_pod: 'orders-db-1',
      record: {
        error_severity: 'ERROR',
        user_name: 'app',
        database_name: 'app',
        message: 'relation "x" does not exist',
        query: 'select * from x',
      },
    });
    expect(plain(formatLogLine(line))).toBe(
      '2026-10-07 09:00:00.123 ERROR   postgres app@app relation "x" does not exist | query: select * from x',
    );
    expect(formatLogLine(line)).toContain('\x1b[31m');
  });

  it('keeps the extra fields of instance manager lines', () => {
    const line = JSON.stringify({
      level: 'info',
      ts: '2026-10-07T09:00:00Z',
      logger: 'wal-archive',
      msg: 'Archived WAL file',
      logging_pod: 'orders-db-1',
      walName: '000000010000000000000003',
    });
    expect(plain(formatLogLine(line))).toBe(
      '2026-10-07 09:00:00Z INFO    wal-archive Archived WAL file walName=000000010000000000000003',
    );
  });

  it('accepts epoch timestamps', () => {
    const line = JSON.stringify({ level: 'info', ts: 1791363600, msg: 'hi' });
    expect(plain(formatLogLine(line))).toMatch(/^2026-\d\d-\d\d \d\d:\d\d:00\.000 INFO/);
  });

  it('ends colours with codes the LogViewer understands, so they do not bleed into later lines', () => {
    const error = JSON.stringify({ level: 'error', msg: 'boom', logger: 'postgres' });
    const info = JSON.stringify({ level: 'info', msg: 'fine', logger: 'postgres' });
    const out = formatLogs(`${error}\n${info}`);
    // Backstage's AnsiProcessor ignores \x1b[0m and \x1b[2m.
    // eslint-disable-next-line no-control-regex
    const codes = new Set(out.match(/\x1b\[[0-9;]*m/g));
    expect([...codes].sort()).toEqual(['\x1b[31m', '\x1b[39m', '\x1b[90m']);
    // The error line closes its red before the info line starts.
    const [first] = out.split('\n');
    expect(first.lastIndexOf('\x1b[39m')).toBeGreaterThan(first.lastIndexOf('\x1b[31m'));
  });

  it('passes non-JSON lines through', () => {
    expect(formatLogLine('plain text')).toBe('plain text');
    expect(formatLogLine('{not json')).toBe('{not json');
    expect(formatLogs('a\n\nb')).toBe('a\n\nb');
  });
});
