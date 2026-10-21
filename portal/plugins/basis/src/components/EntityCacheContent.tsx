import { useEntity } from '@backstage/plugin-catalog-react';
import { Alert, Skeleton } from '@backstage/ui';
import { CACHE_ANNOTATION } from '@internal/backstage-plugin-basis-common';
import { CacheDetails, useCacheDetails } from './CacheDetailPage';
import { ErrorAlert } from './common';

const EntityCacheDetails = ({ namespace, name }: { namespace: string; name: string }) => {
  const { value, error } = useCacheDetails(namespace, name);
  if (error && !value) return <ErrorAlert error={error} />;
  if (!value) return <Skeleton width="100%" height={240} />;
  return <CacheDetails details={value} />;
};

/** "Valkey" tab on catalog Resource entities of ValkeyCaches, created by the basis catalog provider. */
export const EntityCacheContent = () => {
  const { entity } = useEntity();
  const ref = entity.metadata.annotations?.[CACHE_ANNOTATION] ?? '';
  const [namespace, name] = ref.split('/');
  if (!namespace || !name) {
    return (
      <Alert
        status="warning"
        title="Not a ValkeyCache"
        description={`Annotation ${CACHE_ANNOTATION} must be "<project>/<name>".`}
      />
    );
  }
  return <EntityCacheDetails namespace={namespace} name={name} />;
};
