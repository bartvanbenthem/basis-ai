import { useEntity } from '@backstage/plugin-catalog-react';
import { Alert } from '@backstage/ui';
import { CNPG_ANNOTATION } from '@internal/backstage-plugin-cnpg-common';
import { ClusterDetails, ClusterDetailsSkeleton } from './ClusterDetails';
import { useClusterDetails } from './ClusterDetailPage';
import { ErrorAlert } from './common';

const EntityClusterDetails = ({ namespace, name }: { namespace: string; name: string }) => {
  const { value, error } = useClusterDetails(namespace, name);
  if (error && !value) return <ErrorAlert error={error} />;
  if (!value) return <ClusterDetailsSkeleton />;
  return <ClusterDetails details={value} />;
};

/** "PostgreSQL" tab on catalog Resource entities created by the cnpg catalog provider. */
export const EntityPostgresContent = () => {
  const { entity } = useEntity();
  const ref = entity.metadata.annotations?.[CNPG_ANNOTATION] ?? '';
  const [namespace, name] = ref.split('/');
  if (!namespace || !name) {
    return (
      <Alert
        status="warning"
        title="Not a PostgresCluster"
        description={`Annotation ${CNPG_ANNOTATION} must be "<project>/<name>".`}
      />
    );
  }
  return <EntityClusterDetails namespace={namespace} name={name} />;
};
