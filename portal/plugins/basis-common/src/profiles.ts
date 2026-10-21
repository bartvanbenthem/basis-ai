/**
 * Workload profiles (PostgresCluster spec.profile). A profile tunes a
 * cluster for a kind of workload: the size's settings for it
 * (postgres-sizes, sizes[].profiles) and, for vector, exporter metrics on
 * vector indexes. The extensions are the portal's suggestion; the spec lists
 * them like any others.
 */

export const CLUSTER_PROFILES = ['general', 'vector'] as const;
export type ClusterProfile = (typeof CLUSTER_PROFILES)[number];

export interface ClusterProfileInfo {
  name: ClusterProfile;
  displayName: string;
  description: string;
  /** The lowest PostgreSQL major the profile runs on. */
  minPostgresVersion?: number;
  /** Extensions a new cluster with the profile starts with (those in the catalog). */
  extensions: string[];
}

export const PROFILES: Record<ClusterProfile, ClusterProfileInfo> = {
  general: {
    name: 'general',
    displayName: 'General purpose',
    description:
      'Transactional and mixed workloads; the size tunes PostgreSQL as it is.',
    extensions: [],
  },
  vector: {
    name: 'vector',
    displayName: 'Vector & RAG',
    description:
      'Embeddings, retrieval-augmented generation and hybrid search: pgvector, VectorChord for large vector ' +
      'indexes and pg_search (BM25). PostgreSQL 18; the size gets room to build vector indexes in memory.',
    minPostgresVersion: 18,
    extensions: ['vector', 'vchord', 'pg_search'],
  },
};

export const isClusterProfile = (v: unknown): v is ClusterProfile =>
  typeof v === 'string' && (CLUSTER_PROFILES as readonly string[]).includes(v);

/** spec.profile, general when unset or unknown. */
export const clusterProfile = (
  spec: Record<string, any> | undefined,
): ClusterProfile =>
  isClusterProfile(spec?.profile) ? spec!.profile : 'general';
