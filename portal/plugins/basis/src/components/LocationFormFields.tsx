import { Button, Flex, Select, Switch, Text, TextAreaField, TextField } from '@backstage/ui';
import {
  LOCATION_ENVIRONMENTS,
  LOCATION_PROVIDERS,
} from '@internal/backstage-plugin-cnpg-common';
import { useMemo, useRef } from 'react';
import { Mono, Section } from './common';
import {
  chosenContext,
  ENVIRONMENT_LABELS,
  kubeconfigContexts,
  LocationForm,
  NONE,
  PROVIDER_LABELS,
} from './locationForm';

/**
 * Every section of the location form, shared by the add and edit pages. On
 * edit the name is fixed and an empty kubeconfig keeps the stored one.
 */
export const LocationFormFields = ({
  form,
  setForm,
  err,
  editing,
}: {
  form: LocationForm;
  setForm: (update: (f: LocationForm) => LocationForm) => void;
  err: (key: keyof LocationForm) => string | undefined;
  editing?: boolean;
}) => {
  const fileInput = useRef<HTMLInputElement>(null);
  const set = <K extends keyof LocationForm>(key: K) => (value: LocationForm[K]) =>
    setForm(f => ({ ...f, [key]: value }));
  const { contexts, current } = useMemo(() => kubeconfigContexts(form.kubeconfig), [form.kubeconfig]);

  const onFile = async (file?: File) => {
    if (!file) return;
    const text = await file.text();
    setForm(f => ({ ...f, kubeconfig: text, fileName: file.name, context: '' }));
  };

  return (
    <>
      <Section title="Location">
        <TextField
          label="Name"
          isRequired
          isDisabled={editing}
          value={form.name}
          onChange={set('name')}
          description={
            err('name') ??
            (editing
              ? 'Fixed after creation.'
              : 'Lowercase letters, digits and "-", e.g. prod-ams-1.')
          }
          isInvalid={Boolean(err('name'))}
        />
        <TextField
          label="Display name"
          value={form.displayName}
          onChange={set('displayName')}
          description={err('displayName') ?? 'e.g. Production Amsterdam 1'}
          isInvalid={Boolean(err('displayName'))}
        />
        <TextField
          label="Description"
          value={form.description}
          onChange={set('description')}
          description={err('description')}
          isInvalid={Boolean(err('description'))}
        />
        <TextField
          label="Owner (group)"
          value={form.owner}
          onChange={set('owner')}
          description={err('owner') ?? 'Team that runs this cluster.'}
          isInvalid={Boolean(err('owner'))}
        />
      </Section>

      <Section title="Placement" description="Where the cluster runs and what it is for.">
        <Select
          label="Environment"
          value={form.environment}
          onChange={key => set('environment')(String(key) as LocationForm['environment'])}
          options={[
            { id: NONE, label: 'Not set' },
            ...LOCATION_ENVIRONMENTS.map(e => ({ id: e, label: ENVIRONMENT_LABELS[e] })),
          ]}
        />
        <Select
          label="Provider"
          value={form.provider}
          onChange={key => set('provider')(String(key) as LocationForm['provider'])}
          options={[
            { id: NONE, label: 'Not set' },
            ...LOCATION_PROVIDERS.map(p => ({ id: p, label: PROVIDER_LABELS[p] })),
          ]}
        />
        <TextField
          label="Region / data center"
          value={form.region}
          onChange={set('region')}
          description={err('region') ?? 'e.g. westeurope or dc-amsterdam-2'}
          isInvalid={Boolean(err('region'))}
        />
        <TextField
          label="Default StorageClass"
          value={form.storageClass}
          onChange={set('storageClass')}
          description={err('storageClass') ?? "For databases placed here; empty uses the cluster's default."}
          isInvalid={Boolean(err('storageClass'))}
        />
        <Switch
          label="Allow new databases here"
          isSelected={form.schedulable}
          onChange={set('schedulable')}
        />
      </Section>

      <Section
        title="Connection"
        description={
          editing
            ? 'Leave empty to keep the stored kubeconfig; upload one to replace it.'
            : 'The kubeconfig the portal uses to reach the cluster. Only the chosen context is stored.'
        }
      >
        <Flex direction="column" gap="2" style={{ gridColumn: '1 / -1' }}>
          <Flex gap="2" align="center">
            <Button variant="secondary" onPress={() => fileInput.current?.click()}>
              Upload kubeconfig
            </Button>
            <input
              ref={fileInput}
              type="file"
              hidden
              onChange={e => {
                onFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            {form.fileName && <Text variant="body-small" color="secondary">{form.fileName}</Text>}
          </Flex>
          <TextAreaField
            label="kubeconfig"
            aria-label="kubeconfig"
            rows={8}
            value={form.kubeconfig}
            onChange={v => setForm(f => ({ ...f, kubeconfig: v, fileName: undefined }))}
            placeholder={'apiVersion: v1\nkind: Config\n...'}
            style={{ fontFamily: 'var(--bui-font-monospace, monospace)', fontSize: 12 }}
          />
          {err('kubeconfig') && (
            <Text variant="body-small" color="danger">
              {err('kubeconfig')}
            </Text>
          )}
          <Text variant="body-small" color="secondary">
            Use a ServiceAccount token or a client certificate, with the data inline. Kubeconfigs
            that run a command (<Mono>exec</Mono>, e.g. kubelogin or aws eks get-token) or read
            files are rejected: the portal backend would run them.
          </Text>
        </Flex>
        {contexts.length > 1 && (
          <Select
            label="Context"
            value={chosenContext(form)}
            onChange={key => set('context')(String(key))}
            options={contexts.map(c => ({ id: c, label: c === current ? `${c} (current)` : c }))}
          />
        )}
      </Section>
    </>
  );
};
