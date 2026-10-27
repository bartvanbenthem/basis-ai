import { Checkbox, CheckboxGroup, Flex, NumberField, Select, Switch, Text, TextField } from '@backstage/ui';
import {
  CLUSTER_PROFILES,
  ClusterExtension,
  ClusterProfile,
  extensionAvailable,
  IMAGE_EXTENSIONS_MIN_VERSION,
  ProjectSummary,
  PROFILES,
  VECTOR_EXTENSION,
} from '@internal/backstage-plugin-basis-common';
import { Section } from './common';
import { auditOptions, ClusterForm, selectPostgresVersion, selectProfile } from './form';

const opts = (values: Array<string | number>) => values.map(v => ({ id: String(v), label: String(v) }));


/** Explains a field the edit form shows read-only. */
const FIXED = 'Fixed after creation.';

/** The project's two sites; a cluster runs in the protected one and, with geo replication, the recovery one. */
export interface Sites {
  protected?: string;
  recovery?: string;
}

/** "protected (dc-ams)": the site and the location behind it. */
export const siteLabel = (site: keyof Sites, sites?: Sites) =>
  sites?.[site] ? `${site} (${sites[site]})` : site;

/**
 * Every section of the cluster form, shared by the create and edit pages.
 * With `original` (edit mode) the fields that would need a new cluster are
 * read-only, and volumes say they can only grow. `sites` are the project's
 * locations (in create mode they come from the selected project).
 */
export const ClusterFormFields = ({
  form,
  setForm,
  err,
  storageClasses,
  extensions: catalog = [],
  projects,
  onSelectProject,
  original,
  sites: sitesProp,
  backupBucket: backupBucketProp,
}: {
  form: ClusterForm;
  setForm: (update: (f: ClusterForm) => ClusterForm) => void;
  err: (key: keyof ClusterForm) => string | undefined;
  storageClasses: string[];
  /** The extension catalog; without one only the extensions the cluster has are shown. */
  extensions?: ClusterExtension[];
  projects?: ProjectSummary[];
  onSelectProject?: (name: string) => void;
  original?: ClusterForm;
  sites?: Sites;
  /** The project's COSI backup bucket, if it has one (in create mode from the selected project). */
  backupBucket?: ProjectSummary['backupBucket'];
}) => {
  const editing = Boolean(original);
  const set = <K extends keyof ClusterForm>(key: K) => (value: ClusterForm[K]) =>
    setForm(f => ({ ...f, [key]: value }));

  const project = projects?.find(p => p.name === form.namespace);
  const sites: Sites | undefined =
    sitesProp ?? (project && { protected: project.protectedLocation, recovery: project.recoveryLocation });
  const bucket = backupBucketProp ?? project?.backupBucket;
  // Moving a running cluster's WAL archive would cut off its replica cluster.
  const storeFixed = editing && original!.backupEnabled;
  // Geo replication off while the primary is in the recovery site: the
  // composition switches it back first, then removes the replica cluster.
  const draining = editing && original!.geoReplication && !form.geoReplication;
  let geoHelp = 'The project has no recovery location; add one to the project first.';
  if (sites?.recovery) {
    geoHelp =
      draining && original!.primarySite === 'recovery'
        ? `Switches the primary back to ${sites.protected} first, then removes the replica cluster.`
        : 'Needs backups: the replica cluster replays the WAL archive, so the sites need no network path to each other.';
  }

  // The catalog's extensions, plus any the cluster has that it no longer lists.
  const extensionOptions: ClusterExtension[] = [
    ...catalog,
    ...form.extensions
      .filter(name => !catalog.some(e => e.name === name))
      .map(name => ({ name, displayName: name, description: 'Not in the catalog: can be removed, not added again.', parameters: {} })),
  ];
  const removed = editing ? original!.extensions.filter(e => !form.extensions.includes(e)) : [];
  // Extensions that make CNPG load a library or mount an image: adding or
  // removing one restarts the instances.
  const restarts = editing
    ? catalog.filter(
        e =>
          (Object.keys(e.parameters).length || e.sharedPreloadLibraries?.length || e.image) &&
          original!.extensions.includes(e.name) !== form.extensions.includes(e.name),
      )
    : [];
  const unavailable = catalog.filter(e => !extensionAvailable(e, form.postgresVersion));
  const removedImages = catalog.filter(e => e.image && removed.includes(e.name));

  let storageClassField;
  if (editing) {
    storageClassField = (
      <TextField
        label="StorageClass"
        isDisabled
        value={form.storageClass || 'cluster default'}
        description={FIXED}
      />
    );
  } else if (storageClasses.length > 0) {
    storageClassField = (
      <Select
        label="StorageClass"
        value={form.storageClass || '__default__'}
        onChange={k => set('storageClass')(k === '__default__' ? '' : String(k))}
        options={[{ id: '__default__', label: 'cluster default' }, ...opts(storageClasses)]}
      />
    );
  } else {
    storageClassField = (
      <TextField
        label="StorageClass"
        value={form.storageClass}
        onChange={set('storageClass')}
        placeholder="cluster default"
      />
    );
  }

  return (
    <>
      <Section title="Basics">
        <TextField
          label="Name"
          isRequired
          isDisabled={editing}
          value={form.name}
          onChange={set('name')}
          description={err('name') ?? (editing ? FIXED : 'Also the prefix of every Kubernetes object it creates.')}
          isInvalid={Boolean(err('name'))}
        />
        {editing ? (
          <TextField label="Project" isDisabled value={form.namespace} description={FIXED} />
        ) : (
          <Select
            label="Project"
            isRequired
            searchable
            value={form.namespace || null}
            onChange={k => onSelectProject?.(String(k ?? ''))}
            options={(projects ?? []).map(p => ({
              id: p.name,
              label: p.ready ? p.name : `${p.name} (provisioning)`,
            }))}
            description={
              err('namespace') ??
              "Its metrics, alerts and dashboard go to the project's Prometheus and Grafana."
            }
            isInvalid={Boolean(err('namespace'))}
          />
        )}
        <Select
          label="Workload profile"
          value={form.profile}
          onChange={k => setForm(f => selectProfile(f, k as ClusterProfile, catalog, { preset: !editing }))}
          options={CLUSTER_PROFILES.map(p => ({ id: p, label: PROFILES[p].displayName }))}
          description={PROFILES[form.profile].description}
        />
        <Select
          label="PostgreSQL version"
          isDisabled={editing}
          value={String(form.postgresVersion)}
          onChange={k => setForm(f => selectPostgresVersion(f, Number(k), catalog))}
          options={opts([18, 17, 16, 15, 14])}
          description={
            err('postgresVersion') ??
            (editing
              ? 'A major upgrade restarts the whole cluster; run it with kubectl.'
              : 'Major version; minor updates roll out with the image catalog.')
          }
          isInvalid={Boolean(err('postgresVersion'))}
        />
        <NumberField
          label="Instances"
          minValue={1}
          maxValue={9}
          value={form.instances}
          onChange={set('instances')}
          description={
            editing
              ? 'Standbys are added or removed one by one; the primary stays up.'
              : '1 primary + hot standbys. Use 3 for production.'
          }
        />
        <TextField
          label="Owner (group)"
          value={form.owner}
          onChange={set('owner')}
          description={err('owner') ?? 'Catalog owner, e.g. team-payments.'}
          isInvalid={Boolean(err('owner'))}
        />
        <TextField
          label="Database / owner role"
          isDisabled={editing}
          value={form.databaseName}
          onChange={v => setForm(f => ({ ...f, databaseName: v, databaseOwner: v }))}
          description={
            err('databaseName') ??
            (editing ? FIXED : 'Created at bootstrap; credentials go to <name>-app.')
          }
          isInvalid={Boolean(err('databaseName'))}
        />
      </Section>

      <Section
        title="Sites"
        description="The control plane runs no databases: the cluster runs in its project's protected location. With geo replication a replica cluster in the recovery location follows it through the backup object store, ready to take over."
      >
        <TextField
          label="Protected location"
          isDisabled
          value={sites?.protected ?? (form.namespace ? 'none: the project has no protected location' : 'pick a project')}
          description="Where the database runs: the project's protected location."
        />
        <Switch
          label={sites?.recovery ? `Geo replication to ${sites.recovery}` : 'Geo replication'}
          isSelected={form.geoReplication}
          isDisabled={!sites?.recovery && !form.geoReplication}
          onChange={on =>
            setForm(f => ({ ...f, geoReplication: on, ...(on ? {} : { primarySite: 'protected' as const }) }))
          }
        />
        <Text variant="body-small" color={err('geoReplication') ? 'danger' : 'secondary'}>
          {err('geoReplication') ?? geoHelp}
        </Text>
        {form.geoReplication && (
          <NumberField
            label="Replica cluster instances"
            minValue={0}
            maxValue={9}
            value={form.geoInstances}
            onChange={set('geoInstances')}
            description={err('geoInstances') ?? '0: as many as the cluster has.'}
            isInvalid={Boolean(err('geoInstances'))}
          />
        )}
        {editing && original!.geoReplication && (
          <TextField
            label="Primary site"
            isDisabled
            value={siteLabel(original!.primarySite, sites)}
            description="Switch over or fail over from the cluster's Disaster recovery tab."
          />
        )}
      </Section>

      <Section
        title="Resources & storage"
        description={
          editing
            ? 'Per instance. Volumes grow online if the StorageClass allows expansion; new CPU or memory restarts the instances one by one, the primary last (switchover).'
            : 'Per instance; memory is request and limit. PostgreSQL\'s settings (shared_buffers, work_mem, ...) are tuned to them.'
        }
      >
        <TextField
          label="CPU"
          value={form.cpu}
          onChange={set('cpu')}
          description={err('cpu') ?? 'e.g. 500m or 2'}
          isInvalid={Boolean(err('cpu'))}
        />
        <TextField
          label="Memory"
          value={form.memory}
          onChange={set('memory')}
          description={err('memory') ?? 'e.g. 1Gi or 8Gi'}
          isInvalid={Boolean(err('memory'))}
        />
        <TextField
          label="Data volume size"
          value={form.storageSize}
          onChange={set('storageSize')}
          description={
            err('storageSize') ??
            (editing ? `Can grow, not shrink (now ${original!.storageSize}).` : 'Can grow later if the StorageClass allows expansion.')
          }
          isInvalid={Boolean(err('storageSize'))}
        />
        {storageClassField}
        <Switch
          label={editing && !form.walEnabled ? 'Separate WAL volume (only at creation)' : 'Separate WAL volume'}
          isDisabled={editing}
          isSelected={form.walEnabled}
          onChange={set('walEnabled')}
        />
        {form.walEnabled && (
          <TextField
            label="WAL volume size"
            value={form.walSize}
            onChange={set('walSize')}
            description={err('walSize') ?? (editing ? `Can grow, not shrink (now ${original!.walSize}).` : undefined)}
            isInvalid={Boolean(err('walSize'))}
          />
        )}
      </Section>

      <Section title="High availability">
        <Select
          label="Pod anti-affinity"
          value={form.podAntiAffinityType}
          onChange={k => set('podAntiAffinityType')(k as ClusterForm['podAntiAffinityType'])}
          options={[
            { id: 'preferred', label: 'preferred (best effort)' },
            { id: 'required', label: 'required (one instance per node)' },
          ]}
        />
        <NumberField
          label="Synchronous replicas"
          minValue={0}
          maxValue={Math.max(form.instances - 1, 0)}
          value={form.synchronousReplicas}
          onChange={set('synchronousReplicas')}
          description={err('synchronousReplicas') ?? '0 = asynchronous replication.'}
          isInvalid={Boolean(err('synchronousReplicas'))}
        />
        <Switch
          label="Spread across zones"
          isSelected={form.zoneSpread}
          onChange={set('zoneSpread')}
        />
        {form.synchronousReplicas > 0 && (
          <Select
            label="When no sync standby is available"
            value={form.synchronousDataDurability}
            onChange={k =>
              set('synchronousDataDurability')(k as ClusterForm['synchronousDataDurability'])
            }
            options={[
              { id: 'preferred', label: 'keep accepting writes (preferred)' },
              { id: 'required', label: 'block writes (required)' },
            ]}
          />
        )}
      </Section>

      <Section
        title="External access"
        description="Internal by default: applications in the cluster's location connect to the -rw service (or the pooler), which follows the primary after a switchover. Expose it only for clients outside the location, such as admin tools or migrations."
      >
        <Switch
          label="Expose through a LoadBalancer"
          isSelected={form.exposeEnabled}
          onChange={set('exposeEnabled')}
        />
        {form.exposeEnabled && (
          <TextField
            label="Allowed client CIDRs"
            isRequired
            value={form.exposeSourceRanges}
            onChange={set('exposeSourceRanges')}
            placeholder="203.0.113.10/32, 10.0.0.0/8"
            description={
              err('exposeSourceRanges') ??
              'Only these reach port 5432 on <name>-external. Connect with sslmode=verify-full and the CA in Secret <name>-ca.'
            }
            isInvalid={Boolean(err('exposeSourceRanges'))}
          />
        )}
      </Section>

      <Section title="Connection pooling" description="PgBouncer in front of the cluster.">
        <Switch
          label="Enable PgBouncer"
          isSelected={form.poolerEnabled}
          onChange={set('poolerEnabled')}
        />
        {form.poolerEnabled && (
          <>
            <Select
              label="Pool mode"
              value={form.poolMode}
              onChange={k => set('poolMode')(k as ClusterForm['poolMode'])}
              options={opts(['transaction', 'session'])}
            />
            <NumberField
              label="Pooler instances"
              minValue={1}
              maxValue={10}
              value={form.poolerInstances}
              onChange={set('poolerInstances')}
            />
            <Switch
              label="Also pool the read-only service"
              isSelected={form.poolerReadOnly}
              onChange={set('poolerReadOnly')}
            />
          </>
        )}
      </Section>

      <Section
        title="Backups"
        description="Continuous WAL archiving and scheduled base backups to S3-compatible storage."
      >
        <Switch
          label="Enable backups"
          isSelected={form.backupEnabled}
          onChange={on =>
            setForm(f => ({
              ...f,
              backupEnabled: on,
              // The project's bucket, unless a destination was typed already.
              ...(on && bucket && !storeFixed && !f.backupDestinationPath ? { backupProjectBucket: true } : {}),
            }))
          }
        />
        {form.backupEnabled && (bucket || form.backupProjectBucket) && (
          <Switch
            label={bucket?.bucket ? `Store in the project's bucket (${bucket.bucket})` : "Store in the project's bucket"}
            isSelected={form.backupProjectBucket}
            isDisabled={storeFixed}
            onChange={set('backupProjectBucket')}
          />
        )}
        {form.backupEnabled && form.backupProjectBucket && (
          <Text variant="body-small" color={bucket ? 'secondary' : 'warning'}>
            {storeFixed && "Fixed: moving a running cluster's WAL archive would cut off its replica cluster. "}
            {bucket
              ? `COSI provisioned it for the project; each site gets credentials of its own.${bucket.ready ? '' : ' Still provisioning: the cluster waits for it.'}`
              : 'The project has no backup bucket; turn this off and give a destination of your own.'}
          </Text>
        )}
        {form.backupEnabled && (
          <>
            {!form.backupProjectBucket && (
              <>
                <TextField
                  label="Destination"
                  placeholder="s3://bucket/path"
                  value={form.backupDestinationPath}
                  onChange={set('backupDestinationPath')}
                  description={err('backupDestinationPath')}
                  isInvalid={Boolean(err('backupDestinationPath'))}
                />
                <TextField
                  label="Endpoint URL"
                  placeholder="https://object.storage.example.com"
                  value={form.backupEndpointURL}
                  onChange={set('backupEndpointURL')}
                  description="Leave empty for AWS S3."
                />
                <TextField
                  label="Credentials Secret"
                  value={form.backupSecretName}
                  onChange={set('backupSecretName')}
                  description={err('backupSecretName') ?? 'Keys ACCESS_KEY_ID and ACCESS_SECRET_KEY, in the same project.'}
                  isInvalid={Boolean(err('backupSecretName'))}
                />
              </>
            )}
            <TextField
              label="Retention"
              value={form.backupRetention}
              onChange={set('backupRetention')}
              description={err('backupRetention')}
              isInvalid={Boolean(err('backupRetention'))}
            />
            <TextField
              label="Schedule"
              value={form.backupSchedule}
              onChange={set('backupSchedule')}
              description={err('backupSchedule') ?? 'Six-field cron, seconds first.'}
              isInvalid={Boolean(err('backupSchedule'))}
            />
          </>
        )}
      </Section>

      <Section title="Monitoring">
        <Switch
          label="Prometheus metrics & alerts"
          isSelected={form.monitoringEnabled}
          onChange={set('monitoringEnabled')}
        />
        <Switch
          label="Grafana dashboard"
          isSelected={form.dashboardEnabled}
          onChange={set('dashboardEnabled')}
        />
      </Section>

      <Section
        title="Audit logging"
        description="pgaudit records who ran which statement, on which object; the project's Audit logs page shows the records."
      >
        <Switch
          label="Audit logging (pgaudit)"
          isSelected={form.auditEnabled}
          onChange={set('auditEnabled')}
        />
        {form.auditEnabled && (
          <Select
            label="What to record"
            value={form.auditLog}
            onChange={key => set('auditLog')(String(key))}
            options={auditOptions(form.auditLog)}
            description={err('auditLog')}
            isInvalid={Boolean(err('auditLog'))}
          />
        )}
        {editing && form.auditEnabled !== original!.auditEnabled && (
          <Text variant="body-small" color="secondary">
            {form.auditEnabled ? 'Turning it on' : 'Turning it off'} loads or unloads the pgaudit library: the instances
            restart one by one, the primary last (switchover).
          </Text>
        )}
      </Section>

      <Section
        title="Extensions"
        description={`Installed in the ${form.databaseName || 'app'} database (CREATE EXTENSION). pgvector adds vector similarity search for embeddings: AI, RAG and recommendations.`}
      >
        {extensionOptions.length ? (
          <CheckboxGroup
            aria-label="Extensions"
            value={form.extensions}
            // Catalog order, so the spec doesn't change with the click order.
            onChange={v => set('extensions')(extensionOptions.map(e => e.name).filter(n => v.includes(n)))}
          >
            {extensionOptions.map(e => (
              <Checkbox
                key={e.name}
                value={e.name}
                // Can't be added below 18; one the cluster has can still be unticked.
                isDisabled={!extensionAvailable(e, form.postgresVersion) && !form.extensions.includes(e.name)}
              >
                <Flex direction="column" gap="0">
                  <Text>{e.displayName}</Text>
                  {e.description && (
                    <Text variant="body-small" color="secondary">
                      {e.description}
                    </Text>
                  )}
                </Flex>
              </Checkbox>
            ))}
          </CheckboxGroup>
        ) : (
          <Text variant="body-small" color="secondary">
            The platform offers no extensions (EnvironmentConfig postgres-extensions).
          </Text>
        )}
        {unavailable.length > 0 && (
          <Text variant="body-small" color="secondary">
            {unavailable.map(e => e.displayName).join(', ')} {unavailable.length === 1 ? 'is' : 'are'} mounted from an
            image, which needs PostgreSQL {IMAGE_EXTENSIONS_MIN_VERSION} or later.
          </Text>
        )}
        {form.extensions.includes(VECTOR_EXTENSION) && (!editing || !original!.extensions.includes(VECTOR_EXTENSION)) && (
          <Text variant="body-small" color="secondary">
            Building an HNSW index on many vectors uses a lot of memory (maintenance_work_mem): give it 8Gi or
            more for millions of embeddings
            {form.profile === 'vector'
              ? ', which the Vector & RAG profile gives more of.'
              : ', and the Vector & RAG profile for more of it.'}
          </Text>
        )}
        {removed.length > 0 && (
          <Text variant="body-small" color="warning">
            {removed.join(', ')} stay{removed.length === 1 ? 's' : ''} installed: dropping an extension also drops
            the columns and indexes that use it, so do that with psql if you mean it.
          </Text>
        )}
        {removedImages.length > 0 && (
          <Text variant="body-small" color="warning">
            {removedImages.map(e => e.displayName).join(', ')} {removedImages.length === 1 ? 'is' : 'are'} no longer
            mounted once removed: drop the indexes and columns that use{' '}
            {removedImages.length === 1 ? 'it' : 'them'} first (DROP EXTENSION ... CASCADE), or they stop working.
          </Text>
        )}
        {restarts.length > 0 && (
          <Text variant="body-small" color="secondary">
            {restarts.map(e => e.displayName).join(', ')} loads a library: the instances restart one by one, the
            primary last (switchover).
          </Text>
        )}
      </Section>
    </>
  );
};
