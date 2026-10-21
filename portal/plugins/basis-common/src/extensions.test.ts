import { extensionAvailable, parseExtensions, specExtensions } from './extensions';

describe('parseExtensions', () => {
  it('reads the catalog in order', () => {
    expect(
      parseExtensions({
        extensions: [
          { name: 'vector', displayName: 'pgvector', description: 'Vector similarity search' },
          { name: 'pg_stat_statements', parameters: { 'pg_stat_statements.track': 'top', 'pg_stat_statements.max': 5000 } },
        ],
      }),
    ).toEqual([
      { name: 'vector', displayName: 'pgvector', description: 'Vector similarity search', parameters: {} },
      {
        name: 'pg_stat_statements',
        displayName: 'pg_stat_statements',
        parameters: { 'pg_stat_statements.track': 'top', 'pg_stat_statements.max': '5000' },
      },
    ]);
  });

  it('skips entries the API could not list', () => {
    expect(
      parseExtensions({
        extensions: [{ name: 'PostGIS' }, { displayName: 'no name' }, { name: 'citext' }, { name: 'citext' }],
      }).map(e => e.name),
    ).toEqual(['citext']);
  });

  it('is empty without a catalog', () => {
    expect(parseExtensions(undefined)).toEqual([]);
    expect(parseExtensions({ extensions: 'vector' })).toEqual([]);
  });
});

describe('specExtensions', () => {
  it('lists every database\'s extensions once, the bootstrap database first', () => {
    expect(
      specExtensions({
        database: { name: 'docs', extensions: ['vector', 'pg_trgm'] },
        databases: [{ name: 'a', extensions: ['pg_stat_statements', 'vector'] }, { name: 'b' }],
      }),
    ).toEqual(['vector', 'pg_trgm', 'pg_stat_statements']);
  });

  it('is empty without extensions', () => {
    expect(specExtensions({ database: { name: 'app' } })).toEqual([]);
    expect(specExtensions(undefined)).toEqual([]);
  });
});

describe('image extensions', () => {
  const [vchord, vector] = parseExtensions({
    extensions: [
      {
        name: 'vchord',
        requires: ['vector'],
        sharedPreloadLibraries: ['vchord'],
        image: { reference: 'ghcr.io/tensorchord/vchord-scratch:pg18@sha256:abc' },
      },
      { name: 'vector' },
    ],
  });

  it('reads the image, what it requires and preloads', () => {
    expect(vchord).toEqual({
      name: 'vchord',
      displayName: 'vchord',
      parameters: {},
      sharedPreloadLibraries: ['vchord'],
      image: true,
      requires: ['vector'],
    });
    expect(vector).toEqual({ name: 'vector', displayName: 'vector', parameters: {} });
  });

  it('needs PostgreSQL 18 for an image extension only', () => {
    expect(extensionAvailable(vchord, 17)).toBe(false);
    expect(extensionAvailable(vchord, 18)).toBe(true);
    expect(extensionAvailable(vector, 14)).toBe(true);
  });
});
