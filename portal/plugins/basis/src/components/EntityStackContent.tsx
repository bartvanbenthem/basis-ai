import { useApi } from '@backstage/frontend-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { Alert, Skeleton } from '@backstage/ui';
import { STACK_ANNOTATION } from '@internal/backstage-plugin-basis-common';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { basisApiRef } from '../api';
import { ErrorAlert } from './common';
import { StackDetails } from './StackDetailPage';

const EntityStackDetails = ({ namespace, name }: { namespace: string; name: string }) => {
  const api = useApi(basisApiRef);
  const { value, error, retry } = useAsyncRetry(() => api.getStack(namespace, name), [api, namespace, name]);
  useInterval(retry, 10_000);
  if (error && !value) return <ErrorAlert error={error} />;
  if (!value) return <Skeleton width="100%" height={240} />;
  return <StackDetails summary={value.summary} resource={value.resource} />;
};

/** "GenAI stack" tab on catalog Resource entities of GenAIStacks, created by the basis catalog provider. */
export const EntityStackContent = () => {
  const { entity } = useEntity();
  const ref = entity.metadata.annotations?.[STACK_ANNOTATION] ?? '';
  const [namespace, name] = ref.split('/');
  if (!namespace || !name) {
    return (
      <Alert status="warning" title="Not a GenAIStack" description={`Annotation ${STACK_ANNOTATION} must be "<project>/<name>".`} />
    );
  }
  return <EntityStackDetails namespace={namespace} name={name} />;
};
