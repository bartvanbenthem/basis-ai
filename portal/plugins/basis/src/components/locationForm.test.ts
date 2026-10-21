import {
  defaultLocationForm,
  fromLocation,
  kubeconfigContexts,
  toLocationSpec,
  validateLocation,
} from './locationForm';

const KUBECONFIG = `
apiVersion: v1
kind: Config
current-context: prod
contexts:
  - name: prod
    context: { cluster: c, user: u }
  - name: dev
    context: { cluster: c, user: u }
`;

describe('locationForm', () => {
  it('lists the contexts of a kubeconfig', () => {
    expect(kubeconfigContexts(KUBECONFIG)).toEqual({ contexts: ['prod', 'dev'], current: 'prod' });
    expect(kubeconfigContexts('')).toEqual({ contexts: [] });
    expect(kubeconfigContexts('a: [').error).toBe('Not valid YAML.');
    expect(kubeconfigContexts('apiVersion: v1').error).toMatch(/No contexts/);
  });

  it('needs a kubeconfig when adding, not when editing', () => {
    const form = { ...defaultLocationForm(), name: 'prod-ams' };
    expect(validateLocation(form).kubeconfig).toBeDefined();
    expect(validateLocation(form, { editing: true })).toEqual({});
  });

  it('checks names, owner and the chosen context', () => {
    const errors = validateLocation({
      ...defaultLocationForm(),
      name: 'Prod',
      owner: 'group:default/x',
      kubeconfig: KUBECONFIG,
      context: 'staging',
    });
    expect(Object.keys(errors).sort()).toEqual(['context', 'name', 'owner']);
  });

  it('round-trips the settings and drops empty ones', () => {
    const spec = { displayName: 'Prod AMS', environment: 'production' as const, schedulable: false };
    const form = fromLocation({
      name: 'prod-ams',
      spec,
      connection: { server: 's', context: 'c', auth: 'token', insecureSkipTlsVerify: false },
      providerConfig: true,
    });
    expect(form.kubeconfig).toBe('');
    expect(toLocationSpec(form)).toEqual({
      displayName: 'Prod AMS',
      description: undefined,
      owner: undefined,
      environment: 'production',
      provider: undefined,
      region: undefined,
      storageClass: undefined,
      schedulable: false,
    });
  });
});
