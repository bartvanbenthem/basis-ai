import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  Container,
  Flex,
  Grid,
  Header,
  Skeleton,
  Text,
} from '@backstage/ui';
import type { LocationHealth } from '@internal/backstage-plugin-cnpg-common';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useAsync from 'react-use/esm/useAsync';
import { cnpgApiRef } from '../api';
import { locationRouteRef } from '../routes';
import { ErrorAlert } from './common';
import { LocationFormFields } from './LocationFormFields';
import {
  chosenContext,
  defaultLocationForm,
  fromLocation,
  LocationForm,
  toLocationSpec,
  validateLocation,
} from './locationForm';
import { HealthChecks, LocationHealthBadge } from './LocationHealth';

/**
 * Right-hand column: the connection test result and the Test / Save buttons.
 * A location can be saved while unreachable (it may be firewalled for now);
 * the test just shows what the portal sees.
 */
const ConnectionPanel = ({
  health,
  hasErrors,
  error,
  submitting,
  onSubmit,
  saveLabel,
  testHint,
}: {
  health?: LocationHealth;
  hasErrors: boolean;
  error?: Error;
  submitting?: 'test' | 'save';
  onSubmit: (test: boolean) => void;
  saveLabel: string;
  testHint: string;
}) => (
  <Flex direction="column" gap="3" style={{ position: 'sticky', top: 16 }}>
    <Card>
      <CardHeader>
        <Flex justify="between" align="center">
          <Text variant="title-x-small" as="h3">
            Connection test
          </Text>
          {health && <LocationHealthBadge health={health} />}
        </Flex>
      </CardHeader>
      <CardBody>
        {submitting === 'test' && <Skeleton width="100%" height={120} />}
        {submitting !== 'test' && health && <HealthChecks health={health} />}
        {submitting !== 'test' && !health && (
          <Text variant="body-small" color="secondary">
            {testHint}
          </Text>
        )}
      </CardBody>
    </Card>
    {hasErrors && <Alert status="warning" title="Fix the highlighted fields first" />}
    {error && <ErrorAlert error={error} />}
    <Flex gap="2" justify="end">
      <Button
        variant="secondary"
        loading={submitting === 'test'}
        isDisabled={Boolean(submitting)}
        onPress={() => onSubmit(true)}
      >
        Test connection
      </Button>
      <Button
        variant="primary"
        loading={submitting === 'save'}
        isDisabled={Boolean(submitting)}
        onPress={() => onSubmit(false)}
      >
        {saveLabel}
      </Button>
    </Flex>
  </Flex>
);

/** Form state, validation and submit handling shared by the add and edit pages. */
function useLocationForm(
  initial: LocationForm,
  editing: boolean,
  submit: (form: LocationForm, test: boolean) => Promise<LocationHealth | void>,
) {
  const [form, setForm] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState<'test' | 'save'>();
  const [result, setResult] = useState<{ error?: Error; health?: LocationHealth }>({});

  const errors = useMemo(() => validateLocation(form, { editing }), [form, editing]);
  const err = (key: keyof LocationForm) => (touched ? errors[key] : undefined);

  const update = (fn: (f: LocationForm) => LocationForm) => {
    setForm(f => {
      const next = fn(f);
      // A test result belongs to the kubeconfig it ran against.
      if (next.kubeconfig !== f.kubeconfig || next.context !== f.context) setResult({});
      return next;
    });
  };

  const onSubmit = async (test: boolean) => {
    setTouched(true);
    if (Object.keys(errors).length) return;
    setSubmitting(test ? 'test' : 'save');
    setResult(r => ({ health: r.health }));
    try {
      const health = await submit(form, test);
      if (health) setResult({ health });
    } catch (e) {
      setResult({ error: e as Error });
    } finally {
      setSubmitting(undefined);
    }
  };

  return {
    form,
    update,
    err,
    panel: {
      health: result.health,
      error: result.error,
      submitting,
      onSubmit,
      hasErrors: touched && Object.keys(errors).length > 0,
    },
  };
}

const FormLayout = ({ fields, panel }: { fields: React.ReactNode; panel: React.ReactNode }) => (
  <Grid.Root columns={{ initial: '1', lg: '3' }} gap="4">
    <Grid.Item colSpan={{ initial: '1', lg: '2' }}>
      <Flex direction="column" gap="4">
        {fields}
      </Flex>
    </Grid.Item>
    <Grid.Item>{panel}</Grid.Item>
  </Grid.Root>
);

export const CreateLocationPage = () => {
  const api = useApi(cnpgApiRef);
  const navigate = useNavigate();
  const locationLink = useRouteRef(locationRouteRef);

  const { form, update, err, panel } = useLocationForm(
    defaultLocationForm(),
    false,
    async (f, test) => {
      const request = {
        name: f.name,
        kubeconfig: f.kubeconfig,
        context: chosenContext(f),
        spec: toLocationSpec(f),
      };
      if (test) return api.testLocation(request);
      await api.createLocation(request);
      navigate(locationLink?.({ name: f.name }) ?? '/cnpg/locations');
      return undefined;
    },
  );

  return (
    <>
      <Header
        title="Add location"
        description="A Kubernetes cluster the platform can run data services in"
      />
      <Container>
        <FormLayout
          fields={<LocationFormFields form={form} setForm={update} err={err} />}
          panel={
            <ConnectionPanel
              {...panel}
              saveLabel="Add location"
              testHint="Test the kubeconfig before adding: the portal connects to the API server, checks it is ready, counts Ready nodes and looks for CloudNativePG."
            />
          }
        />
      </Container>
    </>
  );
};

const EditLocationForm = ({ initial }: { initial: LocationForm }) => {
  const api = useApi(cnpgApiRef);
  const navigate = useNavigate();
  const locationLink = useRouteRef(locationRouteRef);
  const name = initial.name;

  const { form, update, err, panel } = useLocationForm(initial, true, async (f, test) => {
    const request = {
      spec: toLocationSpec(f),
      ...(f.kubeconfig.trim() ? { kubeconfig: f.kubeconfig, context: chosenContext(f) } : {}),
    };
    if (test) return api.testLocationUpdate(name, request);
    await api.updateLocation(name, request);
    navigate(locationLink?.({ name }) ?? '/cnpg/locations');
    return undefined;
  });

  return (
    <FormLayout
      fields={<LocationFormFields form={form} setForm={update} err={err} editing />}
      panel={
        <ConnectionPanel
          {...panel}
          saveLabel="Save"
          testHint="Tests the new kubeconfig if you uploaded one, else the stored one."
        />
      }
    />
  );
};

export const EditLocationPage = () => {
  const { name = '' } = useParams();
  const api = useApi(cnpgApiRef);
  const { value, error } = useAsync(() => api.getLocation(name), [api, name]);

  return (
    <>
      <Header title={`Edit ${value?.spec.displayName || name}`} tags={[{ label: 'location' }]} />
      <Container>
        {error && <ErrorAlert error={error} />}
        {!error && !value && <Skeleton width="100%" height={320} />}
        {value && <EditLocationForm initial={fromLocation(value)} />}
      </Container>
    </>
  );
};
