import type { Project } from '@internal/backstage-plugin-basis-common';
import {
  accessEditable,
  defaultProjectForm,
  fromProject,
  toProjectEditPatch,
  toProjectManifest,
  toProjectSpec,
  validateProject,
  validateProjectEdit,
} from './projectForm';

describe('create-project form', () => {
  it('maps the defaults onto the protected location and observability settings only', () => {
    expect(toProjectSpec({ ...defaultProjectForm(), name: 'team-a', protectedLocation: 'ske' })).toEqual({
      locations: { protected: 'ske' },
      observability: {
        prometheus: { retention: '7d', storage: { size: '10Gi' } },
        grafana: { ingress: true },
      },
    });
  });

  it('adds access entries and the quota only when set', () => {
    const spec = toProjectSpec({
      ...defaultProjectForm(),
      name: 'team-a',
      editGroup: ' team-a-devs ',
      viewGroup: 'auditors',
      quotaEnabled: true,
    }) as any;
    expect(spec.access).toEqual([
      { group: 'team-a-devs', role: 'edit' },
      { group: 'auditors', role: 'view' },
    ]);
    expect(spec.quota).toEqual({ cpu: '8', memory: '32Gi', storage: '200Gi' });
  });

  it('puts owner and description into the manifest preview', () => {
    const manifest = toProjectManifest({
      ...defaultProjectForm(),
      name: 'team-a',
      owner: 'team-a',
      description: 'Team A',
    });
    expect(manifest.metadata).toEqual({ name: 'team-a' });
    expect(manifest.spec).toMatchObject({ owner: 'team-a', description: 'Team A' });
  });

  it('mirrors the XRD name rules', () => {
    const nameError = (name: string) => validateProject({ ...defaultProjectForm(), name }).name;
    expect(nameError('team-a')).toBeUndefined();
    expect(nameError('Team_A')).toBeDefined();
    expect(nameError('a--b')).toBeDefined();
    expect(nameError('kube-x')).toMatch(/reserved/);
    expect(nameError('projects')).toMatch(/reserved/);
    expect(nameError('x'.repeat(41))).toBeDefined();
  });

  it('flags invalid quota and retention values', () => {
    const errors = validateProject({
      ...defaultProjectForm(),
      name: 'team-a',
      protectedLocation: 'ske',
      quotaEnabled: true,
      quotaMemory: '32GB',
      prometheusRetention: '7 days',
    });
    expect(Object.keys(errors).sort()).toEqual(['prometheusRetention', 'quotaMemory']);
  });
});

const live: Project = {
  apiVersion: 'platform.cndev.nl/v1alpha1',
  kind: 'Project',
  metadata: { name: 'team-a' },
  spec: {
    owner: 'team-a',
    deletionProtection: true,
    locations: { protected: 'ske' },
    access: [{ group: 'team-a-devs', role: 'edit' }],
    quota: { cpu: '8', memory: '32Gi', storage: '200Gi' },
    observability: {
      prometheus: { enabled: true, retention: '7d', storage: { size: '10Gi' } },
      grafana: { enabled: true, ingress: true },
    },
  },
};

describe('edit-project form', () => {
  const original = fromProject(live);

  it('reads an existing project and sends nothing when unchanged', () => {
    expect(original).toMatchObject({ name: 'team-a', owner: 'team-a', editGroup: 'team-a-devs', quotaEnabled: true });
    expect(toProjectEditPatch(original, original)).toEqual({});
  });

  it('grows the Prometheus volume and removes the quota', () => {
    expect(
      toProjectEditPatch(original, { ...original, prometheusStorage: '50Gi', quotaEnabled: false }),
    ).toEqual({ quota: null, observability: { prometheus: { storage: { size: '50Gi' } } } });
  });

  it('replaces the access list as a whole, or clears it', () => {
    expect(toProjectEditPatch(original, { ...original, viewGroup: 'auditors' })).toEqual({
      access: [
        { group: 'team-a-devs', role: 'edit' },
        { group: 'auditors', role: 'view' },
      ],
    });
    expect(toProjectEditPatch(original, { ...original, editGroup: '' })).toEqual({ access: null });
  });

  it("leaves an access list the form can't show alone", () => {
    const admins = [{ group: 'ops', role: 'admin' as const }];
    expect(accessEditable(admins)).toBe(false);
    expect(accessEditable(live.spec.access)).toBe(true);
    const form = fromProject({ ...live, spec: { ...live.spec, access: admins } });
    expect(toProjectEditPatch(form, { ...form, owner: '' }, { keepAccess: true })).toEqual({ owner: null });
  });

  it('refuses to shrink the Prometheus volume', () => {
    expect(validateProjectEdit(original, { ...original, prometheusStorage: '5Gi' }).prometheusStorage).toMatch(
      /not shrink/,
    );
  });

  it('needs a protected location and a different recovery location', () => {
    const f = { ...defaultProjectForm(), name: 'x' };
    expect(validateProject(f).protectedLocation).toBeDefined();
    expect(validateProject({ ...f, protectedLocation: 'ske' })).toEqual({});
    expect(validateProject({ ...f, protectedLocation: 'ske', recoveryLocation: 'ske' }).recoveryLocation).toBeDefined();
    expect(toProjectSpec({ ...f, protectedLocation: 'ske' })).toMatchObject({ locations: { protected: 'ske' } });
    expect(toProjectSpec({ ...f, protectedLocation: 'ske', recoveryLocation: 'ams' })).toMatchObject({
      locations: { protected: 'ske', recovery: 'ams' },
    });
  });

  it('adds a recovery location later, but changes neither once set', () => {
    const withRecovery = { ...original, recoveryLocation: 'ams' };
    expect(toProjectEditPatch(original, withRecovery)).toEqual({ locations: { recovery: 'ams' } });
    expect(validateProjectEdit(original, withRecovery)).toEqual({});
    expect(validateProjectEdit(withRecovery, { ...withRecovery, recoveryLocation: '' }).recoveryLocation).toMatch(/Fixed/);
    expect(validateProjectEdit(original, { ...original, protectedLocation: 'other' }).protectedLocation).toMatch(/Fixed/);
  });
});
