import { InputError } from '@backstage/errors';
import { dumpYaml, KubeConfig, loadYaml } from '@kubernetes/client-node';
import type { LocationConnection } from '@internal/backstage-plugin-cnpg-common';

export const MAX_KUBECONFIG_BYTES = 256 * 1024;

/**
 * Credential types a stored kubeconfig may not use. The backend loads these
 * kubeconfigs itself, so `exec` and `auth-provider` would run commands on it
 * and the file references would read its files. Only inline credentials are
 * accepted: a ServiceAccount token or a client certificate.
 */
const FORBIDDEN_USER_KEYS: Record<string, string> = {
  exec: 'runs a command to get credentials',
  'auth-provider': 'runs a cloud provider plugin to get credentials',
  'token-file': 'reads the token from a file',
  tokenFile: 'reads the token from a file',
  'client-certificate': 'reads the certificate from a file (use client-certificate-data)',
  'client-key': 'reads the key from a file (use client-key-data)',
};

const FORBIDDEN_CLUSTER_KEYS: Record<string, string> = {
  'certificate-authority': 'reads the CA from a file (use certificate-authority-data)',
};

type Named = { name?: string; [key: string]: any };

function entries(raw: any, key: string): Named[] {
  const list = raw?.[key];
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new InputError(`kubeconfig: "${key}" must be a list`);
  return list;
}

function find(list: Named[], name: string, what: string): Record<string, any> {
  const entry = list.find(e => e?.name === name);
  if (!entry) throw new InputError(`kubeconfig: ${what} "${name}" not found`);
  return entry[what] ?? {};
}

function authOf(user: Record<string, any>): string {
  if (user.token) return 'token';
  if (user['client-certificate-data'] && user['client-key-data']) return 'client certificate';
  if (user.username && user.password) return 'basic';
  throw new InputError(
    'kubeconfig: the user has no inline credentials; give it a token or client-certificate-data and client-key-data',
  );
}

/**
 * Validates an uploaded kubeconfig and cuts it down to one context, so the
 * stored Secret holds just the credentials for this location.
 *
 * @param text - the kubeconfig as uploaded (YAML or JSON)
 * @param context - the context to keep; defaults to current-context, or the only one
 */
export function parseKubeconfig(
  text: string,
  context?: string,
): { kubeconfig: string; connection: LocationConnection } {
  if (Buffer.byteLength(text) > MAX_KUBECONFIG_BYTES) {
    throw new InputError(`kubeconfig: larger than ${MAX_KUBECONFIG_BYTES / 1024} KiB`);
  }
  let raw: any;
  try {
    raw = loadYaml(text);
  } catch (e) {
    throw new InputError(`kubeconfig: not valid YAML (${(e as Error).message.split('\n')[0]})`);
  }
  if (!raw || typeof raw !== 'object') throw new InputError('kubeconfig: empty or not a mapping');

  const contexts = entries(raw, 'contexts');
  const names = contexts.map(c => c?.name).filter(Boolean) as string[];
  if (!names.length) throw new InputError('kubeconfig: has no contexts');
  const contextName =
    context || raw['current-context'] || (names.length === 1 ? names[0] : undefined);
  if (!contextName) {
    throw new InputError(`kubeconfig: pick a context (${names.join(', ')})`);
  }
  if (!names.includes(contextName)) {
    throw new InputError(
      `kubeconfig: context "${contextName}" not found (available: ${names.join(', ')})`,
    );
  }

  const ctx = find(contexts, contextName, 'context');
  if (!ctx.cluster || !ctx.user) {
    throw new InputError(`kubeconfig: context "${contextName}" needs a cluster and a user`);
  }
  const cluster = find(entries(raw, 'clusters'), ctx.cluster, 'cluster');
  const user = find(entries(raw, 'users'), ctx.user, 'user');

  for (const [key, why] of Object.entries(FORBIDDEN_CLUSTER_KEYS)) {
    if (cluster[key]) throw new InputError(`kubeconfig: cluster uses "${key}", which ${why}`);
  }
  for (const [key, why] of Object.entries(FORBIDDEN_USER_KEYS)) {
    if (user[key]) {
      throw new InputError(
        `kubeconfig: user uses "${key}", which ${why}. Use a ServiceAccount token or a client certificate instead.`,
      );
    }
  }

  let server: URL;
  try {
    server = new URL(String(cluster.server ?? ''));
  } catch {
    throw new InputError('kubeconfig: cluster has no valid "server" URL');
  }
  if (server.protocol !== 'https:') {
    throw new InputError('kubeconfig: the API server must be reached over https');
  }
  const auth = authOf(user);

  const minimal = {
    apiVersion: 'v1',
    kind: 'Config',
    'current-context': contextName,
    contexts: [{ name: contextName, context: ctx }],
    clusters: [{ name: ctx.cluster, cluster }],
    users: [{ name: ctx.user, user }],
  };
  const kubeconfig = dumpYaml(minimal);
  // Fails on anything the client itself can't use.
  try {
    new KubeConfig().loadFromString(kubeconfig);
  } catch (e) {
    throw new InputError(`kubeconfig: ${(e as Error).message}`);
  }

  return {
    kubeconfig,
    connection: {
      server: server.toString().replace(/\/$/, ''),
      context: contextName,
      auth,
      namespace: ctx.namespace,
      insecureSkipTlsVerify: Boolean(cluster['insecure-skip-tls-verify']),
    },
  };
}
