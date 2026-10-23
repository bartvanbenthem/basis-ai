import { NavContentBlueprint } from '@backstage/plugin-app-react';
import { Link, useLocation } from 'react-router-dom';
import { BasisLogo } from './BasisLogo';

type Item = {
  label: string;
  to: string;
  isActive: (path: string, search: string) => boolean;
};

const BASIS = '/basis';
const STACKS = `${BASIS}/stacks`;
const GATEWAYS = `${BASIS}/gateways`;
const SERVERS = `${BASIS}/servers`;
const MCP = `${BASIS}/mcp-servers`;
const CACHES = `${BASIS}/caches`;
/** The PostgreSQL pages live at the root: /basis, /basis/create, /basis/<project>/<name>. */
const isClusterPath = (p: string) =>
  p === BASIS ||
  (p.startsWith(`${BASIS}/`) &&
    !['audit', 'projects', 'locations', 'buckets', 'volumes', 'caches', 'stacks', 'gateways', 'servers', 'mcp-servers'].some(s =>
      p.startsWith(`${BASIS}/${s}`),
    ));
const under = (prefix: string) => (p: string) => p.startsWith(prefix) && !p.startsWith(`${prefix}/create`);

/**
 * A fixed list rather than every installed page: what teams build first
 * (AI services), then the building blocks a stack is made of, then the
 * platform the admins run. Each list page has its own Create button.
 */
const sections: Array<{ title: string; items: Item[] }> = [
  {
    title: 'AI services',
    items: [
      { label: 'GenAI stacks', to: STACKS, isActive: under(STACKS) },
      { label: 'New stack', to: `${STACKS}/create`, isActive: p => p.startsWith(`${STACKS}/create`) },
      { label: 'MCP servers', to: MCP, isActive: p => p.startsWith(MCP) },
    ],
  },
  {
    title: 'Building blocks',
    items: [
      { label: 'Model gateways', to: GATEWAYS, isActive: p => p.startsWith(GATEWAYS) },
      { label: 'Model servers', to: SERVERS, isActive: p => p.startsWith(SERVERS) },
      { label: 'PostgreSQL', to: BASIS, isActive: isClusterPath },
      { label: 'Valkey caches', to: CACHES, isActive: p => p.startsWith(CACHES) },
    ],
  },
  {
    title: 'Platform',
    items: [
      { label: 'Projects', to: `${BASIS}/projects`, isActive: p => p.startsWith(`${BASIS}/projects`) },
      { label: 'Locations', to: `${BASIS}/locations`, isActive: p => p.startsWith(`${BASIS}/locations`) },
      { label: 'Volumes', to: `${BASIS}/volumes`, isActive: p => p.startsWith(`${BASIS}/volumes`) },
      { label: 'Buckets', to: `${BASIS}/buckets`, isActive: p => p.startsWith(`${BASIS}/buckets`) },
      { label: 'Audit logs', to: `${BASIS}/audit`, isActive: p => p.startsWith(`${BASIS}/audit`) },
    ],
  },
  {
    title: 'Docs',
    items: [
      {
        // TechDocs of the basis System (portal/catalog/mkdocs.yml).
        label: 'Platform docs',
        to: '/docs/default/system/basis',
        isActive: p => p.startsWith('/docs'),
      },
      {
        // The APIs' OpenAPI documents, generated from the XRDs.
        label: 'API reference',
        to: '/api-docs',
        isActive: p =>
          p.startsWith('/api-docs') || p.startsWith('/catalog/default/api/'),
      },
    ],
  },
];

const BasisNav = () => {
  const { pathname, search } = useLocation();
  return (
    <nav className="tp-nav" aria-label="sidebar nav">
      <Link to={STACKS} className="tp-nav__brand" aria-label="Home">
        <BasisLogo height={26} />
        <span className="tp-nav__product">Sovereign AI services</span>
      </Link>
      <div className="tp-nav__sections">
        {sections.map(section => (
          <div key={section.title} className="tp-nav__section">
            <div className="tp-nav__heading">{section.title}</div>
            {section.items.map(item => (
              <Link
                key={item.to}
                to={item.to}
                className="tp-nav__item"
                aria-current={
                  item.isActive(pathname, search) ? 'page' : undefined
                }
              >
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </div>
      <div className="tp-nav__footer">Powered by cndev.nl</div>
    </nav>
  );
};

export const SidebarContent = NavContentBlueprint.make({
  params: { component: () => <BasisNav /> },
});
