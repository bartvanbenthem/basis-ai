import { Select, Switch, Text, TextField } from '@backstage/ui';
import type { LocationSummary, Project } from '@internal/backstage-plugin-cnpg-common';
import { Section } from './common';
import { ProjectForm } from './projectForm';

/**
 * Every section of the project form, shared by the create and edit pages.
 * With `original` (edit mode) the name is read-only and the Prometheus
 * volume says it can only grow. `lockedAccess` is an access list the form
 * can't represent; it's shown, not edited. `locations` are the registered
 * locations a project can use as its sites. Once set, a site is read-only;
 * a recovery site can still be added.
 */
export const ProjectFormFields = ({
  form,
  setForm,
  err,
  original,
  lockedAccess,
  locations,
}: {
  form: ProjectForm;
  setForm: (update: (f: ProjectForm) => ProjectForm) => void;
  err: (key: keyof ProjectForm) => string | undefined;
  original?: ProjectForm;
  lockedAccess?: Project['spec']['access'];
  locations?: LocationSummary[];
}) => {
  const editing = Boolean(original);
  const set = <K extends keyof ProjectForm>(key: K) => (value: ProjectForm[K]) =>
    setForm(f => ({ ...f, [key]: value }));

  const known = new Map((locations ?? []).map(l => [l.name, l]));
  const describeLocation = (name: string) => {
    const l = known.get(name);
    if (!l) return `${name} (not registered)`;
    const notes = [
      l.spec.displayName,
      l.spec.environment,
      l.spec.region,
      !l.providerConfig && 'not usable by Crossplane yet',
      l.spec.schedulable === false && 'closed for new databases',
    ].filter(Boolean);
    return notes.length ? `${name} (${notes.join(', ')})` : name;
  };
  // A location closed for new databases can't be picked.
  const open = (name: string) =>
    known.get(name)?.spec.schedulable !== false && known.get(name)?.providerConfig !== false;
  const options = (exclude: string) =>
    [...known.keys()]
      .filter(name => name !== exclude)
      .sort()
      .map(name => ({ id: name, label: describeLocation(name), disabled: !open(name) }));
  const fixedProtected = Boolean(original?.protectedLocation);
  const fixedRecovery = Boolean(original?.recoveryLocation);
  const NONE = '__none__';

  return (
    <>
      <Section title="Basics">
        <TextField
          label="Name"
          isRequired
          isDisabled={editing}
          value={form.name}
          onChange={set('name')}
          description={
            err('name') ??
            (editing
              ? 'The namespace name; fixed after creation.'
              : 'Lowercase letters, digits and single "-", max 40 characters.')
          }
          isInvalid={Boolean(err('name'))}
        />
        <TextField
          label="Owner (group)"
          value={form.owner}
          onChange={set('owner')}
          description={err('owner') ?? 'Catalog owner of the project and, by default, its databases.'}
          isInvalid={Boolean(err('owner'))}
        />
        <TextField
          label="Description"
          value={form.description}
          onChange={set('description')}
          description={err('description')}
          isInvalid={Boolean(err('description'))}
        />
      </Section>

      <Section
        title="Locations"
        description="The Kubernetes clusters the project's databases run in; the control plane runs none. Each gets the namespace, access, quota and a Prometheus that forwards to this project's Grafana."
      >
        {fixedProtected ? (
          <TextField
            label="Protected location"
            isDisabled
            value={describeLocation(form.protectedLocation)}
            description="Where the databases run; fixed after creation."
          />
        ) : (
          <Select
            label="Protected location"
            isRequired
            value={form.protectedLocation || null}
            onChange={k => set('protectedLocation')(String(k ?? ''))}
            options={options(form.recoveryLocation)}
            placeholder={known.size ? 'Pick a location' : 'No locations registered yet'}
            description={err('protectedLocation') ?? 'Where the databases run. Fixed after creation.'}
            isInvalid={Boolean(err('protectedLocation'))}
          />
        )}
        {fixedRecovery ? (
          <TextField
            label="Recovery location"
            isDisabled
            value={describeLocation(form.recoveryLocation)}
            description="Where geo-replicated databases keep a replica cluster; fixed once set."
          />
        ) : (
          <Select
            label="Recovery location"
            value={form.recoveryLocation || NONE}
            onChange={k => set('recoveryLocation')(k === NONE ? '' : String(k ?? ''))}
            options={[{ id: NONE, label: 'none' }, ...options(form.protectedLocation)]}
            description={
              err('recoveryLocation') ??
              'Optional: where databases with geo replication keep a replica cluster that can take over. Can be added later; fixed once set.'
            }
            isInvalid={Boolean(err('recoveryLocation'))}
          />
        )}
      </Section>

      <Section
        title="Access"
        description="Kubernetes groups from your identity provider that get access to the project."
      >
        {lockedAccess ? (
          <Text variant="body-small" color="secondary">
            {lockedAccess.map(a => `${a.group} (${a.role})`).join(', ')}. This list has
            more entries than the form can show; change it with kubectl.
          </Text>
        ) : (
          <>
            <TextField
              label="Group with edit access"
              value={form.editGroup}
              onChange={set('editGroup')}
              description='Built-in "edit" role: manage PostgresClusters, read Secrets.'
            />
            <TextField
              label="Group with view access"
              value={form.viewGroup}
              onChange={set('viewGroup')}
              description='Built-in "view" role.'
            />
          </>
        )}
      </Section>

      <Section title="Quota" description="Caps on what the whole project may request.">
        <Switch
          label="Limit total resources"
          isSelected={form.quotaEnabled}
          onChange={set('quotaEnabled')}
        />
        {form.quotaEnabled && (
          <>
            <TextField
              label="CPU requests"
              value={form.quotaCpu}
              onChange={set('quotaCpu')}
              description={err('quotaCpu')}
              isInvalid={Boolean(err('quotaCpu'))}
            />
            <TextField
              label="Memory"
              value={form.quotaMemory}
              onChange={set('quotaMemory')}
              description={err('quotaMemory')}
              isInvalid={Boolean(err('quotaMemory'))}
            />
            <TextField
              label="Storage"
              value={form.quotaStorage}
              onChange={set('quotaStorage')}
              description={
                err('quotaStorage') ??
                (editing
                  ? 'All PVCs together, including Prometheus. Raise it before growing volumes.'
                  : 'All PVCs together, including Prometheus.')
              }
              isInvalid={Boolean(err('quotaStorage'))}
            />
          </>
        )}
      </Section>

      <Section
        title="Observability"
        description="Every PostgreSQL cluster in the project reports to this Prometheus and gets its dashboard in this Grafana."
      >
        <TextField
          label="Metrics retention"
          value={form.prometheusRetention}
          onChange={set('prometheusRetention')}
          description={err('prometheusRetention')}
          isInvalid={Boolean(err('prometheusRetention'))}
        />
        <TextField
          label="Prometheus volume size"
          value={form.prometheusStorage}
          onChange={set('prometheusStorage')}
          description={
            err('prometheusStorage') ??
            (editing
              ? `Grows online if the StorageClass allows expansion; can't shrink (now ${original!.prometheusStorage}).`
              : undefined)
          }
          isInvalid={Boolean(err('prometheusStorage'))}
        />
        <Switch
          label="Expose Grafana through the cluster ingress"
          isSelected={form.grafanaIngress}
          onChange={set('grafanaIngress')}
        />
      </Section>
    </>
  );
};
