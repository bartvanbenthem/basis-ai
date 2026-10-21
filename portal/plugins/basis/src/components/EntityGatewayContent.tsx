import { useApi } from '@backstage/frontend-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { Alert, Skeleton } from '@backstage/ui';
import { GATEWAY_ANNOTATION } from '@internal/backstage-plugin-basis-common';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { basisApiRef } from '../api';
import { ErrorAlert } from './common';
import { GatewayDetails } from './GatewayDetailPage';

const EntityGatewayDetails = ({ namespace, name }: { namespace: string; name: string }) => {
  const api = useApi(basisApiRef);
  const { value, error, retry } = useAsyncRetry(() => api.getGateway(namespace, name), [api, namespace, name]);
  useInterval(retry, 10_000);
  if (error && !value) return <ErrorAlert error={error} />;
  if (!value) return <Skeleton width="100%" height={240} />;
  return <GatewayDetails summary={value.summary} resource={value.resource} usedBy={value.stacks} />;
};

/** "Model gateway" tab on catalog Resource entities of ModelGateways, created by the basis catalog provider. */
export const EntityGatewayContent = () => {
  const { entity } = useEntity();
  const ref = entity.metadata.annotations?.[GATEWAY_ANNOTATION] ?? '';
  const [namespace, name] = ref.split('/');
  if (!namespace || !name) {
    return (
      <Alert status="warning" title="Not a ModelGateway" description={`Annotation ${GATEWAY_ANNOTATION} must be "<project>/<name>".`} />
    );
  }
  return <EntityGatewayDetails namespace={namespace} name={name} />;
};
