import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { Container, Flex, Grid, Header } from '@backstage/ui';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import useAsync from 'react-use/esm/useAsync';
import { stringify } from 'yaml';
import { cnpgApiRef } from '../api';
import { projectRouteRef } from '../routes';
import { ManifestPanel } from './common';
import { ProjectFormFields } from './ProjectFormFields';
import {
  defaultProjectForm,
  ProjectForm,
  toProjectManifest,
  toProjectSpec,
  validateProject,
} from './projectForm';

export const CreateProjectPage = () => {
  const api = useApi(cnpgApiRef);
  const navigate = useNavigate();
  const projectLink = useRouteRef(projectRouteRef);

  // Without permission to read locations the form just offers none.
  const { value: locations } = useAsync(() => api.listLocations().catch(() => []), [api]);
  const [form, setForm] = useState<ProjectForm>(defaultProjectForm());
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState<'validate' | 'create'>();
  const [result, setResult] = useState<{ error?: Error; validated?: boolean }>({});

  const update = (fn: (f: ProjectForm) => ProjectForm) => {
    setForm(fn);
    setResult({});
  };

  const errors = useMemo(() => validateProject(form), [form]);
  const err = (key: keyof ProjectForm) => (touched ? errors[key] : undefined);
  const manifest = useMemo(() => stringify(toProjectManifest(form)), [form]);

  const submit = async (dryRun: boolean) => {
    setTouched(true);
    if (Object.keys(errors).length) return;
    setSubmitting(dryRun ? 'validate' : 'create');
    setResult({});
    try {
      await api.createProject({
        name: form.name,
        owner: form.owner || undefined,
        description: form.description || undefined,
        spec: toProjectSpec(form),
        dryRun,
      });
      if (dryRun) {
        setResult({ validated: true });
      } else {
        navigate(projectLink?.({ name: form.name }) ?? '/cnpg/projects');
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
        title="Create project"
        description="A project with its own Prometheus and Grafana, ready for PostgreSQL clusters"
      />
      <Container>
        <Grid.Root columns={{ initial: '1', lg: '3' }} gap="4">
          <Grid.Item colSpan={{ initial: '1', lg: '2' }}>
            <Flex direction="column" gap="4">
              <ProjectFormFields form={form} setForm={update} err={err} locations={locations} />
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
              createLabel="Create project"
            />
          </Grid.Item>
        </Grid.Root>
      </Container>
    </>
  );
};
