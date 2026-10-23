import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { actionsRegistryServiceRef } from '@backstage/backend-plugin-api/alpha';
import { basisPermissions } from '@internal/backstage-plugin-basis-common';
import { registerActions } from './actions';
import { createRouter } from './router';
import { auditServiceRef } from './service/AuditService';
import { costServiceRef } from './service/CostService';
import { bucketServiceRef } from './service/BucketService';
import { basisKubernetesServiceRef } from './service/BasisKubernetesService';
import { locationServiceRef } from './service/LocationService';
import { gatewayServiceRef } from './service/GatewayService';
import { mcpServiceRef } from './service/McpService';
import { providerKeyServiceRef } from './service/ProviderKeyService';
import { serverServiceRef } from './service/ServerService';
import { stackServiceRef } from './service/StackService';
import { valkeyServiceRef } from './service/ValkeyService';
import { volumeServiceRef } from './service/VolumeService';

/**
 * REST API for the BASIS portal: list / inspect / create / update / delete
 * the BASIS APIs (GenAIStacks, ModelGateways, ModelServers, MCPServers, PostgresClusters,
 * ValkeyCaches, Projects and Locations). Mounted at /api/basis.
 *
 * @public
 */
export const basisPlugin = createBackendPlugin({
  pluginId: 'basis',
  register(env) {
    env.registerInit({
      deps: {
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
        permissions: coreServices.permissions,
        permissionsRegistry: coreServices.permissionsRegistry,
        config: coreServices.rootConfig,
        k8s: basisKubernetesServiceRef,
        locations: locationServiceRef,
        buckets: bucketServiceRef,
        volumes: volumeServiceRef,
        audit: auditServiceRef,
        cost: costServiceRef,
        valkey: valkeyServiceRef,
        stacks: stackServiceRef,
        gateways: gatewayServiceRef,
        servers: serverServiceRef,
        mcp: mcpServiceRef,
        providerKeys: providerKeyServiceRef,
        actionsRegistry: actionsRegistryServiceRef,
      },
      async init({
        httpAuth,
        httpRouter,
        permissions,
        permissionsRegistry,
        config,
        k8s,
        locations,
        buckets,
        volumes,
        audit,
        cost,
        valkey,
        stacks,
        gateways,
        servers,
        mcp,
        providerKeys,
        actionsRegistry,
      }) {
        permissionsRegistry.addPermissions(basisPermissions);
        httpRouter.use(
          await createRouter({
            httpAuth,
            permissions,
            config,
            k8s,
            locations,
            buckets,
            volumes,
            audit,
        cost,
            valkey,
            stacks,
            gateways,
            servers,
            mcp,
            providerKeys,
          }),
        );
        httpRouter.addAuthPolicy({ path: '/health', allow: 'unauthenticated' });
        // The same, as MCP tools for agents (plugin-mcp-actions-backend).
        registerActions({ actionsRegistry, permissions, k8s, stacks, gateways, servers, mcp });
      },
    });
  },
});
