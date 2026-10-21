/**
 * Extensions a PostgresCluster may install in its databases
 * (spec.database.extensions, spec.databases[].extensions): the
 * EnvironmentConfig postgres-extensions on the control plane
 * (api/apis/postgrescluster/extensions.yaml). An admission policy rejects new ones
 * that aren't in it; the composition adds the settings an extension needs.
 */

export const EXTENSIONS_NAME = 'postgres-extensions';

/** pgvector's extension name: what spec...extensions lists for vector search. */
export const VECTOR_EXTENSION = 'vector';

/** The first PostgreSQL major that loads extensions mounted from images. */
export const IMAGE_EXTENSIONS_MIN_VERSION = 18;

export interface ClusterExtension {
  /** What the extensions lists say (CREATE EXTENSION <name>). */
  name: string;
  displayName: string;
  description?: string;
  /** postgresql.conf settings the composition adds while a database uses it. */
  parameters: Record<string, string>;
  /** Libraries CNPG preloads while a database uses it (a restart to add or remove). */
  sharedPreloadLibraries?: string[];
  /** Mounted from an image (CNPG image volume extensions): PostgreSQL 18+ only. */
  image?: boolean;
  /** Extensions the composition creates first, e.g. vector for vchord. */
  requires?: string[];
}

/** Whether a cluster on this PostgreSQL major can use the extension. */
export const extensionAvailable = (e: ClusterExtension, postgresVersion: number) =>
  !e.image || postgresVersion >= IMAGE_EXTENSIONS_MIN_VERSION;

/** The XRD's pattern for an extension name. */
const NAME = /^[a-z0-9_-]+$/;

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : undefined);

/**
 * The extensions in an EnvironmentConfig's data, in catalog order. Entries
 * without a valid name are skipped, as the API can't list them either.
 */
export function parseExtensions(data: unknown): ClusterExtension[] {
  const list = (data as any)?.extensions;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const extensions: ClusterExtension[] = [];
  for (const e of list) {
    const name = str(e?.name);
    if (!name || !NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    const parameters = Object.fromEntries(
      Object.entries(e.parameters && typeof e.parameters === 'object' ? e.parameters : {})
        .map(([k, v]) => [k, str(v)])
        .filter((p): p is [string, string] => p[1] !== undefined),
    );
    const names = (v: unknown) =>
      Array.isArray(v) ? v.map(str).filter((n): n is string => Boolean(n)) : [];
    const preload = names(e.sharedPreloadLibraries);
    const requires = names(e.requires);
    extensions.push({
      name,
      displayName: str(e.displayName) || name,
      ...(str(e.description) ? { description: str(e.description) } : {}),
      parameters,
      ...(preload.length ? { sharedPreloadLibraries: preload } : {}),
      ...(str(e.image?.reference) ? { image: true } : {}),
      ...(requires.length ? { requires } : {}),
    });
  }
  return extensions;
}

/**
 * Every extension a cluster's spec lists, the bootstrap database's first,
 * each once.
 */
export function specExtensions(spec: Record<string, any> | undefined): string[] {
  const lists: unknown[] = [
    spec?.database?.extensions,
    ...(Array.isArray(spec?.databases) ? spec!.databases.map((d: any) => d?.extensions) : []),
  ];
  const names = lists.flatMap(l => (Array.isArray(l) ? l : [])).filter((e): e is string => typeof e === 'string');
  return [...new Set(names)];
}
