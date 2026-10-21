/**
 * Backend for the CNPG portal.
 *
 * - default export: the `cnpg` plugin (REST API at /api/cnpg)
 * - `catalogModuleCnpg`: mirrors Projects, PostgresClusters and ValkeyCaches into the catalog
 * - `scaffolderModuleCnpg`: the `cnpg:postgrescluster:create`,
 *   `cnpg:project:create` and `cnpg:valkeycache:create` actions
 *
 * @packageDocumentation
 */
export { cnpgPlugin as default } from './plugin';
export { catalogModuleCnpg } from './modules/catalog';
export { scaffolderModuleCnpg } from './modules/scaffolder';
