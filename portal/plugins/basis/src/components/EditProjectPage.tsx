import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import { Alert, Container, Flex, Grid, Header, Skeleton } from '@backstage/ui';
import { cnpgProjectUpdatePermission } from '@internal/backstage-plugin-cnpg-common';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useAsync from 'react-use/esm/useAsync';
import { stringify } from 'yaml';
import { cnpgApiRef } from '../api';
import { projectRouteRef } from '../routes';
import { ErrorAlert, ManifestPanel } from './common';
import { ProjectFormFields } from './ProjectFormFields';
import {
  accessEditable,
  fromProject,
  ProjectForm,
  toProjectEditPatch,
  validateProjectEdit,
} from './projectForm';

/** Changes a project's owner, access, quota and observability settings. */
export const EditProjectPage = () => {
  const { name = '' } = useParams();
  const api = useApi(cnpgApiRef);
  const navigate = useNavigate();
  const projectLink = useRouteRef(projectRouteRef);
  const { allowed: canUpdate, loading: permissionLoading } = usePermission({
    permission: cnpgProjectUpdatePermission,
  });

  const { value: project, error: loadError } = useAsync(() => api.getProject(name), [api, name]);
  const { value: locations } = useAsync(() => api.listLocations().catch(() => []), [api]);
  const original = useMemo(() => project && fromProject(project.resource), [project]);
  const access = project?.resource.spec.access;
  const keepAccess = !accessEditable(access);

  const [form, setForm] = useState<ProjectForm>();
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState<'validate' | 'create'>();
  const [result, setResult] = useState<{ error?: Error; validated?: boolean }>({});

  useEffect(() => {
    if (original) setForm(original);
  }, [original]);

  const update = (fn: (f: ProjectForm) => ProjectForm) => {
    setForm(f => f && fn(f));
    setResult({});
  };

  const errors = useMemo(
    () => (form && original ? validateProjectEdit(original, form) : {}),
    [form, original],
  );
  const err = (key: keyof ProjectForm) => (touched ? errors[key] : undefined);
  const spec = useMemo(
    () => (form && original ? toProjectEditPatch(original, form, { keepAccess }) : {}),
    [form, original, keepAccess],
  );
  const unchanged = Object.keys(spec).length === 0;
  const preview = useMemo(() => stringify({ spec }), [spec]);

  const back = projectLink?.({ name }) ?? '/cnpg/projects';

  const submit = async (dryRun: boolean) => {
    setTouched(true);
    if (Object.keys(errors).length) return;
    setSubmitting(dryRun ? 'validate' : 'create');
    setResult({});
    try {
      await api.patchProject(name, { spec, dryRun });
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
        tags={[{ label: 'project' }]}
        breadcrumbs={[{ label: name, href: back }]}
      />
      <Container>
        {loadError && <ErrorAlert error={loadError} />}
        {!loadError && !form && <Skeleton width="100%" height={240} />}
        {!permissionLoading && !canUpdate && (
          <Alert status="warning" title="You may not change this project" />
        )}
        {form && original && canUpdate && (
          <Grid.Root columns={{ initial: '1', lg: '3' }} gap="4">
            <Grid.Item colSpan={{ initial: '1', lg: '2' }}>
              <Flex direction="column" gap="4">
                <ProjectFormFields
                  form={form}
                  setForm={update}
                  err={err}
                  original={original}
                  lockedAccess={keepAccess ? access : undefined}
                  locations={locations}
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
