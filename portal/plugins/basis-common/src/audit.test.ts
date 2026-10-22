import { parseGatewayLine, parsePgAuditLine, pgauditLog } from './audit';

const line = (record: object, extra: object = {}) =>
  JSON.stringify({ level: 'info', ts: '2026-10-07T09:12:03Z', logger: 'pgaudit', msg: 'record', logging_pod: 'orders-db-1', record, ...extra });

describe('parsePgAuditLine', () => {
  it('reads a pgaudit record', () => {
    expect(
      parsePgAuditLine(
        line({
          log_time: '2026-10-07 09:12:03.123 UTC',
          user_name: 'app',
          database_name: 'orders',
          connection_from: '10.0.0.7:51234',
          command_tag: 'CREATE TABLE',
          audit: {
            audit_type: 'SESSION',
            class: 'DDL',
            command: 'CREATE TABLE',
            object_type: 'TABLE',
            object_name: 'public.orders',
            statement: 'CREATE TABLE orders (id int)',
            parameter: '<not logged>',
          },
        }),
      ),
    ).toEqual({
      source: 'postgresql',
      time: '2026-10-07T09:12:03.123Z',
      actor: 'app@orders',
      action: 'CREATE TABLE',
      object: 'public.orders',
      message: 'CREATE TABLE orders (id int)',
      type: 'DDL',
      instance: 'orders-db-1',
      client: '10.0.0.7:51234',
    });
  });

  it('falls back to the zap timestamp and command tag', () => {
    const entry = parsePgAuditLine(line({ command_tag: 'GRANT', audit: { class: 'ROLE', statement: 'GRANT ...' } }));
    expect(entry).toMatchObject({ time: '2026-10-07T09:12:03Z', action: 'GRANT', type: 'ROLE', actor: undefined });
  });

  it('ignores other lines', () => {
    expect(parsePgAuditLine('plain text')).toBeUndefined();
    expect(parsePgAuditLine('{"logger":"pgaudit"')).toBeUndefined();
    expect(parsePgAuditLine(line({ message: 'checkpoint' }, { logger: 'postgres' }))).toBeUndefined();
    expect(parsePgAuditLine(JSON.stringify({ logger: 'pgaudit', msg: 'no record' }))).toBeUndefined();
  });
});

describe('pgauditLog', () => {
  it('is the pgaudit.log setting, unless it records nothing', () => {
    expect(pgauditLog({ 'pgaudit.log': 'ddl, role' })).toBe('ddl, role');
    expect(pgauditLog({ 'pgaudit.log': 'none' })).toBeUndefined();
    expect(pgauditLog({ 'pgaudit.log': ' ' })).toBeUndefined();
    expect(pgauditLog({ max_connections: '200' })).toBeUndefined();
    expect(pgauditLog(undefined)).toBeUndefined();
  });
});

describe('parseGatewayLine', () => {
  it('reads who called which model, its tokens and how it ended; nothing else', () => {
    const record = JSON.stringify({
      basis: 'gateway', time: '2026-10-22T10:00:00.000Z', client: 'apps', model: 'gpt-oss-120b', method: 'POST',
      path: '/v1/chat/completions', status: 200, details: 'via_upstream', duration_ms: 812, input_tokens: 120,
      output_tokens: 48, total_tokens: 168, request_id: 'r1', source: '10.0.0.7',
    });
    expect(parseGatewayLine(record)).toEqual({
      source: 'gateway', time: '2026-10-22T10:00:00.000Z', location: '', actor: 'apps', action: 'POST /v1/chat/completions',
      object: 'gpt-oss-120b', message: '200, 120 + 48 tokens, 812 ms', type: '2xx', client: '10.0.0.7',
      tokens: { input: 120, output: 48 },
    });
    const refused = parseGatewayLine(JSON.stringify({ basis: 'gateway', client: '-', model: '-', status: 429,
      details: 'request_rate_limited', input_tokens: '-', output_tokens: '-', duration_ms: 1 }));
    expect(refused).toMatchObject({ actor: 'unauthenticated', type: '4xx', message: '429 (request_rate_limited), 1 ms' });
    expect(refused?.tokens).toBeUndefined();
    expect(parseGatewayLine('{"level":"info","msg":"x"}')).toBeUndefined();
    expect(parseGatewayLine('not json "basis":"gateway"')).toBeUndefined();
  });
});
