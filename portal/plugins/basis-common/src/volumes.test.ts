import { cnpgClaim, quantityBytes, volumeRole } from './volumes';

describe('cnpgClaim', () => {
  it('reads cluster, instance and role from CNPG claim names', () => {
    expect(cnpgClaim('orders-db-1')).toEqual({ cluster: 'orders-db', instance: 'orders-db-1', role: 'data' });
    expect(cnpgClaim('orders-db-12-wal')).toEqual({ cluster: 'orders-db', instance: 'orders-db-12', role: 'wal' });
    expect(cnpgClaim('orders-db-2-tbs-idx')).toEqual({
      cluster: 'orders-db',
      instance: 'orders-db-2',
      role: 'tablespace',
      tablespace: 'idx',
    });
  });

  it('ignores other names', () => {
    expect(cnpgClaim('prometheus-data')).toBeUndefined();
    expect(cnpgClaim('orders-db-1-backup')).toBeUndefined();
  });
});

describe('volumeRole', () => {
  it('maps the cnpg.io/pvcRole label', () => {
    expect(volumeRole('PG_DATA')).toBe('data');
    expect(volumeRole('PG_WAL')).toBe('wal');
    expect(volumeRole('PG_TABLESPACE')).toBe('tablespace');
    expect(volumeRole(undefined)).toBeUndefined();
  });
});

describe('quantityBytes', () => {
  it('parses binary and decimal suffixes', () => {
    expect(quantityBytes('20Gi')).toBe(20 * 1024 ** 3);
    expect(quantityBytes('512Mi')).toBe(512 * 1024 ** 2);
    expect(quantityBytes('1G')).toBe(1e9);
    expect(quantityBytes('1024')).toBe(1024);
    expect(quantityBytes('lots')).toBeUndefined();
    expect(quantityBytes(undefined)).toBeUndefined();
  });
});
