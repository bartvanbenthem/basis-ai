import { parseKubeconfig } from './kubeconfig';
import { probe } from './LocationService';

const kubeconfig = (user: object, cluster: object = {}, extra = '') => `
apiVersion: v1
kind: Config
current-context: prod
contexts:
  - name: prod
    context: { cluster: prod-cluster, user: prod-admin, namespace: default }
  - name: dev
    context: { cluster: dev-cluster, user: dev-admin }
clusters:
  - name: prod-cluster
    cluster: ${JSON.stringify({ server: 'https://prod.example.com:6443', 'certificate-authority-data': 'Q0E=', ...cluster })}
  - name: dev-cluster
    cluster: { server: 'https://dev.example.com:6443' }
users:
  - name: prod-admin
    user: ${JSON.stringify(user)}
  - name: dev-admin
    user: { token: dev-token }
${extra}`;

describe('parseKubeconfig', () => {
  it('keeps only the current context and reports the connection', () => {
    const { kubeconfig: stored, connection } = parseKubeconfig(kubeconfig({ token: 'abc' }));
    expect(connection).toEqual({
      server: 'https://prod.example.com:6443',
      context: 'prod',
      auth: 'token',
      namespace: 'default',
      insecureSkipTlsVerify: false,
    });
    expect(stored).toContain('prod.example.com');
    expect(stored).not.toContain('dev.example.com');
    expect(stored).not.toContain('dev-token');
  });

  it('uses the requested context', () => {
    const { connection } = parseKubeconfig(kubeconfig({ token: 'abc' }), 'dev');
    expect(connection).toMatchObject({ context: 'dev', server: 'https://dev.example.com:6443' });
  });

  it('accepts client certificates', () => {
    const { connection } = parseKubeconfig(
      kubeconfig({ 'client-certificate-data': 'Y2VydA==', 'client-key-data': 'a2V5' }),
    );
    expect(connection.auth).toBe('client certificate');
  });

  it.each([
    [{ exec: { command: 'aws' } }, /"exec"/],
    [{ 'auth-provider': { name: 'gcp' } }, /"auth-provider"/],
    [{ 'token-file': '/etc/passwd' }, /"token-file"/],
    [{ 'client-certificate': '/c', 'client-key': '/k' }, /"client-certificate"/],
    [{}, /no inline credentials/],
  ])('rejects user %j', (user, message) => {
    expect(() => parseKubeconfig(kubeconfig(user))).toThrow(message);
  });

  it('rejects CA files and plain http', () => {
    expect(() =>
      parseKubeconfig(kubeconfig({ token: 'a' }, { 'certificate-authority': '/ca.crt' })),
    ).toThrow(/certificate-authority/);
    expect(() =>
      parseKubeconfig(kubeconfig({ token: 'a' }, { server: 'http://prod.example.com' })),
    ).toThrow(/https/);
  });

  it('explains missing contexts and bad input', () => {
    expect(() => parseKubeconfig(kubeconfig({ token: 'a' }), 'nope')).toThrow(
      /context "nope" not found \(available: prod, dev\)/,
    );
    expect(() => parseKubeconfig('{{{')).toThrow(/not valid YAML/);
    expect(() => parseKubeconfig('apiVersion: v1')).toThrow(/no contexts/);
  });
});

describe('probe', () => {
  it('reports an API server that does not answer as unreachable', async () => {
    const { kubeconfig: stored } = parseKubeconfig(
      kubeconfig({ token: 'abc' }, { server: 'https://127.0.0.1:1' }),
    );
    const health = await probe(stored);
    expect(health.status).toBe('unreachable');
    expect(health.checks[0]).toMatchObject({ name: 'API server', status: 'error' });
  });
});
