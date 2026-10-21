/**
 * Backend for the CNPG portal.
 *
 * - default export: the `basis` plugin (REST API at /api/basis)
 * - `catalogModuleBasis`: mirrors Projects, PostgresClusters, ValkeyCaches and GenAIStacks into the catalog
 * - `scaffolderModuleBasis`: the `basis:postgrescluster:create`, `basis:project:create`,
 *   `basis:valkeycache:create` and `basis:genaistack:create` actions
 *
 * @packageDocumentation
 */
export { basisPlugin as default } from './plugin';
export { catalogModuleBasis } from './modules/catalog';
export { scaffolderModuleBasis } from './modules/scaffolder';
