import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import { Alert, ButtonLink, Container, Flex, Grid, Header } from '@backstage/ui';
import { cnpgProjectCreatePermission, isClusterProfile, PROFILES } from '@internal/backstage-plugin-cnpg-common';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import useAsync from 'react-use/esm/useAsync';
import { stringify } from 'yaml';
import { cnpgApiRef } from '../api';
import { clusterRouteRef, createProjectRouteRef } from '../routes';
import { ClusterFormFields } from './ClusterFormFields';
import { ManifestPanel } from './common';
import { ClusterForm, defaultForm, selectProfile, selectSize, toManifest, toSpec, validate } from './form';

export const CreateClusterPage = () => {
  const api = useApi(cnpgApiRef);
  const navigate = useNavigate();
  const clusterLink = useRouteRef(clusterRouteRef);
  const createProjectLink = useRouteRef(createProjectRouteRef);
  const { allowed: canCreateProject } = usePermission({ permission: cnpgProjectCreatePermission });
  const [params] = useSearchParams();

  const { value: config } = useAsync(() => api.getConfig(), [api]);
  // No catalog (or no access to it): custom resources only.
  const { value: sizes } = useAsync(() => api.listSizes().catch(() => []), [api]);
  const { value: extensions } = useAsync(() => api.listExtensions().catch(() => []), [api]);
  // Clusters go into a Project namespace, which comes with its own
  // Prometheus and Grafana; free-text namespaces are no longer offered.
  const { value: projects, loading: projectsLoading } = useAsync(() => api.listProjects(), [api]);

  // ?project=<name> (from a project page) wins over the configured default.
  const [form, setForm] = useState<ClusterForm>(defaultForm(params.get('project') ?? ''));
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState<'validate' | 'create'>();
  const [result, setResult] = useState<{ error?: Error; validated?: boolean }>({});

  useEffect(() => {
    const preferred = config?.defaultNamespace;
    if (preferred && projects?.some(p => p.name === preferred)) {
      setForm(f => (f.namespace ? f : { ...f, namespace: preferred }));
    }
  }, [config, projects]);

  // ?profile=vector (the "New RAG cluster" nav item) presets the profile:
  // its PostgreSQL version and the extensions the catalog offers, once the
  // catalog is loaded.
  const profileParam = params.get('profile');
  const presetProfile = isClusterProfile(profileParam) ? profileParam : 'general';
  const preset = useRef(false);
  useEffect(() => {
    if (presetProfile !== 'general' && extensions && !preset.current) {
      preset.current = true;
      setForm(f => selectProfile(f, presetProfile, extensions, { preset: true }));
    }
  }, [presetProfile, extensions]);

  // A new cluster starts at the catalog's first (smallest) size; a vector
  // cluster at M if there is one, to build its indexes in memory.
  useEffect(() => {
    if (sizes?.length) {
      const first = (presetProfile === 'vector' && sizes.find(s => s.name === 'm')) || sizes[0];
      setForm(f => (f.size ? f : selectSize(f, first.name, sizes, { suggestVolumes: true })));
    }
  }, [sizes, presetProfile]);

  /** Selecting a project also suggests its owner, unless one was typed already. */
  const selectProject = (name: string) => {
    const project = projects?.find(p => p.name === name);
    setForm(f => ({ ...f, namespace: name, owner: f.owner || project?.owner || '' }));
    setResult({});
  };

  const update = (fn: (f: ClusterForm) => ClusterForm) => {
    setForm(fn);
    setResult({});
  };

  const errors = useMemo(() => validate(form), [form]);
  const err = (key: keyof ClusterForm) => (touched ? errors[key] : undefined);
  const manifest = useMemo(() => stringify(toManifest(form)), [form]);

  const submit = async (dryRun: boolean) => {
    setTouched(true);
    if (Object.keys(errors).length) return;
    setSubmitting(dryRun ? 'validate' : 'create');
    setResult({});
    try {
      await api.createCluster({
        name: form.name,
        namespace: form.namespace,
        owner: form.owner || undefined,
        spec: toSpec(form),
        dryRun,
      });
      if (dryRun) {
        setResult({ validated: true });
      } else {
        navigate(clusterLink?.({ namespace: form.namespace, name: form.name }) ?? '/cnpg');
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
        title={presetProfile === 'vector' ? 'Create RAG cluster' : 'Create PostgreSQL cluster'}
        {...(presetProfile !== 'general' ? { description: PROFILES[presetProfile].description } : {})}
      />
      <Container>
        <Grid.Root columns={{ initial: '1', lg: '3' }} gap="4">
          <Grid.Item colSpan={{ initial: '1', lg: '2' }}>
            <Flex direction="column" gap="4">
              {!projectsLoading && projects?.length === 0 && (
                <Alert
                  status="info"
                  title="No projects yet"
                  description="A cluster lives in a project, which comes with its own Prometheus and Grafana. Create a project first."
                  customActions={
                    canCreateProject && createProjectLink ? (
                      <ButtonLink href={createProjectLink()} variant="secondary" size="small">
                        Create project
                      </ButtonLink>
                    ) : undefined
                  }
                />
              )}
              <ClusterFormFields
                form={form}
                setForm={update}
                err={err}
                storageClasses={config?.storageClasses ?? []}
                sizes={sizes}
                extensions={extensions}
                projects={projects}
                onSelectProject={selectProject}
              />
            </Flex>
          </Grid.Item>

          <Grid.Item>
            <ManifestPanel
              manifest={manifest}
              hasErrors={touched && Object.keys(errors).length > 0}
              error={result.error}
              validated={result.validated}
              submitting={submitting}
              onSubmit={submit}
              createLabel="Create cluster"
            />
          </Grid.Item>
        </Grid.Root>
      </Container>
    </>
  );
};
