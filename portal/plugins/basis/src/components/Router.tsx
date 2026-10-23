import { Route, Routes } from 'react-router-dom';
import { AuditLogPage } from './AuditLogPage';
import { CacheDetailPage } from './CacheDetailPage';
import { CreateCachePage, EditCachePage } from './CacheFormPages';
import { CacheListPage } from './CacheListPage';
import { StackDetailPage } from './StackDetailPage';
import { CreateStackPage, EditStackPage } from './StackFormPages';
import { StackListPage } from './StackListPage';
import { GatewayDetailPage } from './GatewayDetailPage';
import { CreateGatewayPage, EditGatewayPage } from './GatewayFormPages';
import { GatewayListPage } from './GatewayListPage';
import { ServerDetailPage } from './ServerDetailPage';
import { CreateServerPage, EditServerPage } from './ServerFormPages';
import { ServerListPage } from './ServerListPage';
import { McpDetailPage } from './McpDetailPage';
import { CreateMcpPage, EditMcpPage } from './McpFormPages';
import { McpListPage } from './McpListPage';
import { BucketDetailPage } from './BucketDetailPage';
import { BucketListPage } from './BucketListPage';
import { ClusterDetailPage } from './ClusterDetailPage';
import { ClusterListPage } from './ClusterListPage';
import { CreateClusterPage } from './CreateClusterPage';
import { CreateProjectPage } from './CreateProjectPage';
import { EditClusterPage } from './EditClusterPage';
import { EditProjectPage } from './EditProjectPage';
import { CreateLocationPage, EditLocationPage } from './LocationFormPages';
import { LocationDetailPage } from './LocationDetailPage';
import { LocationListPage } from './LocationListPage';
import { ProjectDetailPage } from './ProjectDetailPage';
import { ProjectListPage } from './ProjectListPage';
import { VolumeListPage } from './VolumeListPage';

/** Everything under /basis; paths mirror the sub-route refs in ../routes.ts. */
export const Router = () => (
  <Routes>
    <Route path="/" element={<ClusterListPage />} />
    <Route path="/create" element={<CreateClusterPage />} />
    <Route path="/audit" element={<AuditLogPage />} />
    {/* Static "locations"/"projects"/"buckets"/"volumes"/"caches"/"stacks"/"gateways"/"servers"/"mcp-servers" segments outrank /:namespace/:name; all are reserved project names. */}
    <Route path="/locations" element={<LocationListPage />} />
    <Route path="/locations/create" element={<CreateLocationPage />} />
    <Route path="/locations/:name" element={<LocationDetailPage />} />
    <Route path="/locations/:name/edit" element={<EditLocationPage />} />
    <Route path="/buckets" element={<BucketListPage />} />
    <Route path="/buckets/:name" element={<BucketDetailPage />} />
    <Route path="/volumes" element={<VolumeListPage />} />
    <Route path="/stacks" element={<StackListPage />} />
    <Route path="/stacks/create" element={<CreateStackPage />} />
    <Route path="/stacks/:namespace/:name" element={<StackDetailPage />} />
    <Route path="/stacks/:namespace/:name/edit" element={<EditStackPage />} />
    <Route path="/gateways" element={<GatewayListPage />} />
    <Route path="/gateways/create" element={<CreateGatewayPage />} />
    <Route path="/gateways/:namespace/:name" element={<GatewayDetailPage />} />
    <Route path="/gateways/:namespace/:name/edit" element={<EditGatewayPage />} />
    <Route path="/servers" element={<ServerListPage />} />
    <Route path="/servers/create" element={<CreateServerPage />} />
    <Route path="/servers/:namespace/:name" element={<ServerDetailPage />} />
    <Route path="/servers/:namespace/:name/edit" element={<EditServerPage />} />
    <Route path="/mcp-servers" element={<McpListPage />} />
    <Route path="/mcp-servers/create" element={<CreateMcpPage />} />
    <Route path="/mcp-servers/:namespace/:name" element={<McpDetailPage />} />
    <Route path="/mcp-servers/:namespace/:name/edit" element={<EditMcpPage />} />
    <Route path="/caches" element={<CacheListPage />} />
    <Route path="/caches/create" element={<CreateCachePage />} />
    <Route path="/caches/:namespace/:name" element={<CacheDetailPage tab="overview" />} />
    <Route path="/caches/:namespace/:name/monitoring" element={<CacheDetailPage tab="monitoring" />} />
    <Route path="/caches/:namespace/:name/edit" element={<EditCachePage />} />
    <Route path="/projects" element={<ProjectListPage />} />
    <Route path="/projects/create" element={<CreateProjectPage />} />
    <Route path="/projects/:name" element={<ProjectDetailPage />} />
    <Route path="/projects/:name/edit" element={<EditProjectPage />} />
    <Route path="/:namespace/:name" element={<ClusterDetailPage tab="overview" />} />
    <Route path="/:namespace/:name/monitoring" element={<ClusterDetailPage tab="monitoring" />} />
    <Route path="/:namespace/:name/logs" element={<ClusterDetailPage tab="logs" />} />
    <Route path="/:namespace/:name/dr" element={<ClusterDetailPage tab="dr" />} />
    <Route path="/:namespace/:name/backups" element={<ClusterDetailPage tab="backups" />} />
    <Route path="/:namespace/:name/edit" element={<EditClusterPage />} />
  </Routes>
);
