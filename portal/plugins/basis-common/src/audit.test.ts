import { parsePgAuditLine, pgauditLog } from './audit';

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
