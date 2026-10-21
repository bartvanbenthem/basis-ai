import { createBackend } from '@backstage/backend-defaults';
import { mockServices } from '@backstage/backend-test-utils';

// Standalone backend for developing the plugin against your current
// kubeconfig context (`yarn start` in this package), without auth:
//
//   curl localhost:7007/api/cnpg/clusters
//   curl localhost:7007/api/cnpg/clusters/demo/orders-db
//   curl -XPOST localhost:7007/api/cnpg/clusters -H 'Content-Type: application/json' \
//     -d '{"name":"orders-db","namespace":"demo","spec":{"instances":1,"storage":{"size":"1Gi"}}}'
const backend = createBackend();

backend.add(mockServices.auth.factory());
backend.add(mockServices.httpAuth.factory());
backend.add(mockServices.permissions.factory());
backend.add(import('../src'));

backend.start();
