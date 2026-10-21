import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import { Alert, Container, Flex, Grid, Header, Skeleton } from '@backstage/ui';
import { cnpgClusterUpdatePermission } from '@internal/backstage-plugin-cnpg-common';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useAsync from 'react-use/esm/useAsync';
import { stringify } from 'yaml';
import { cnpgApiRef } from '../api';
import { clusterRouteRef } from '../routes';
import { ClusterFormFields } from './ClusterFormFields';
import { ErrorAlert, ManifestPanel } from './common';
import { ClusterForm, fromCluster, toEditPatch, validateEdit } from './form';

/**
 * Changes a running cluster in place: size, instances, HA, pooler, backup
 * and monitoring. Only the changed fields are sent (a merge patch), so
 * settings made outside the portal stay as they are.
 */
export const EditClusterPage = () => {
  const { namespace = '', name = '' } = useParams();
  const api = useApi(cnpgApiRef);
  const navigate = useNavigate();
  const clusterLink = useRouteRef(clusterRouteRef);
  const { allowed: canUpdate, loading: permissionLoading } = usePermission({
    permission: cnpgClusterUpdatePermission,
  });

  const { value: config } = useAsync(() => api.getConfig(), [api]);
  const { value: sizes } = useAsync(() => api.listSizes().catch(() => []), [api]);
  const { value: extensions } = useAsync(() => api.listExtensions().catch(() => []), [api]);
  // Where replica clusters may go; outside a Project only the platform cluster.
  const { value: project } = useAsync(
    () => api.getProject(namespace).catch(() => undefined),
    [api, namespace],
  );
  // Loaded once: polling would overwrite what's being typed.
  const { value: details, error: loadError } = useAsync(
    () => api.getCluster(namespace, name),
    [api, namespace, name],
  );
  const original = useMemo(() => details && fromCluster(details.resource), [details]);

  const [form, setForm] = useState<ClusterForm>();
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState<'validate' | 'create'>();
  const [result, setResult] = useState<{ error?: Error; validated?: boolean }>({});

  useEffect(() => {
    if (original) setForm(original);
  }, [original]);

  const update = (fn: (f: ClusterForm) => ClusterForm) => {
    setForm(f => f && fn(f));
    setResult({});
  };

  const errors = useMemo(
    () => (form && original ? validateEdit(original, form) : {}),
    [form, original],
  );
  const err = (key: keyof ClusterForm) => (touched ? errors[key] : undefined);
  const spec = useMemo(
    () => (form && original ? toEditPatch(original, form) : {}),
    [form, original],
  );
  const ownerChanged = Boolean(form && original && form.owner !== original.owner);
  const unchanged = Object.keys(spec).length === 0 && !ownerChanged;
  const preview = useMemo(
    () =>
      stringify({
        ...(ownerChanged ? { metadata: { labels: { 'backstage.io/owner': form?.owner || null } } } : {}),
        spec,
      }),
    [spec, ownerChanged, form?.owner],
  );

  const back = clusterLink?.({ namespace, name }) ?? '/cnpg';

  const submit = async (dryRun: boolean) => {
    setTouched(true);
    if (!form || Object.keys(errors).length) return;
    setSubmitting(dryRun ? 'validate' : 'create');
    setResult({});
    try {
      await api.patchCluster(namespace, name, {
        spec,
        ...(ownerChanged ? { owner: form.owner || null } : {}),
        dryRun,
      });
      if (dryRun) {
        setResult({ validated: true });
      } else {
        navigate(back);
      }
    } catch (e) {
      setResult({ error: e as Error });
    } finally {
      setSubmitting(undefined);
    }
  };

  return (
    <>
      <Header
        title={`Edit ${name}`}
        tags={[{ label: `project: ${namespace}` }]}
        breadcrumbs={[{ label: name, href: back }]}
      />
      <Container>
        {loadError && <ErrorAlert error={loadError} />}
        {!loadError && !form && <Skeleton width="100%" height={240} />}
        {!permissionLoading && !canUpdate && (
          <Alert status="warning" title="You may not change this cluster" />
        )}
        {form && original && canUpdate && (
          <Grid.Root columns={{ initial: '1', lg: '3' }} gap="4">
            <Grid.Item colSpan={{ initial: '1', lg: '2' }}>
              <Flex direction="column" gap="4">
                {details?.summary.deleting && (
                  <Alert status="warning" title="This cluster is being deleted" />
                )}
                <ClusterFormFields
                  form={form}
                  setForm={update}
                  err={err}
                  storageClasses={config?.storageClasses ?? []}
                  sizes={sizes}
                  extensions={extensions}
                  original={original}
                  sites={{
                    // Pinned by the composition; the project's until then.
                    protected: details?.resource.status?.sites?.protected ?? project?.summary.protectedLocation,
                    recovery: details?.resource.status?.sites?.recovery ?? project?.summary.recoveryLocation,
                  }}
                  backupBucket={project?.summary.backupBucket}
                />
              </Flex>
            </Grid.Item>
            <Grid.Item>
              <ManifestPanel
                title="Changes"
                manifest={preview}
                unchanged={unchanged}
                hasErrors={touched && Object.keys(errors).length > 0}
                error={result.error}
                validated={result.validated}
                submitting={submitting}
                onSubmit={submit}
                createLabel="Save changes"
              />
            </Grid.Item>
          </Grid.Root>
        )}
      </Container>
    </>
  );
};
