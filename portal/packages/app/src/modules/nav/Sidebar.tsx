import { NavContentBlueprint } from '@backstage/plugin-app-react';
import { Link, useLocation } from 'react-router-dom';
import { BasisLogo } from './BasisLogo';

type Item = {
  label: string;
  to: string;
  isActive: (path: string, search: string) => boolean;
};

const CNPG = '/cnpg';
const isClusterPath = (p: string) =>
  p === CNPG ||
  (p.startsWith(`${CNPG}/`) &&
    !p.startsWith(`${CNPG}/create`) &&
    !p.startsWith(`${CNPG}/audit`) &&
    !p.startsWith(`${CNPG}/projects`) &&
    !p.startsWith(`${CNPG}/locations`) &&
    !p.startsWith(`${CNPG}/buckets`) &&
    !p.startsWith(`${CNPG}/volumes`));
const isProjectPath = (p: string) =>
  p.startsWith(`${CNPG}/projects`) && !p.startsWith(`${CNPG}/projects/create`);
const isRagCreate = (p: string, search: string) =>
  p.startsWith(`${CNPG}/create`) &&
  new URLSearchParams(search).get('profile') === 'vector';
const isLocationPath = (p: string) =>
  p.startsWith(`${CNPG}/locations`) &&
  !p.startsWith(`${CNPG}/locations/create`);

/** The portal is CNPG-only, so the nav is a fixed list rather than every installed page. */
const sections: Array<{ title: string; items: Item[] }> = [
  {
    title: 'Locations',
    items: [
      { label: 'Locations', to: `${CNPG}/locations`, isActive: isLocationPath },
      {
        label: 'Add location',
        to: `${CNPG}/locations/create`,
        isActive: p => p.startsWith(`${CNPG}/locations/create`),
      },
    ],
  },
  {
    title: 'Projects',
    items: [
      { label: 'Projects', to: `${CNPG}/projects`, isActive: isProjectPath },
      {
        label: 'New project',
        to: `${CNPG}/projects/create`,
        isActive: p => p.startsWith(`${CNPG}/projects/create`),
      },
      {
        label: 'Volumes',
        to: `${CNPG}/volumes`,
        isActive: p => p.startsWith(`${CNPG}/volumes`),
      },
      {
        label: 'Buckets',
        to: `${CNPG}/buckets`,
        isActive: p => p.startsWith(`${CNPG}/buckets`),
      },
    ],
  },
  {
    title: 'Database',
    items: [
      { label: 'PostgreSQL', to: CNPG, isActive: isClusterPath },
      {
        label: 'New cluster',
        to: `${CNPG}/create`,
        isActive: (p, search) =>
          p.startsWith(`${CNPG}/create`) && !isRagCreate(p, search),
      },
      {
        // The create form with the vector workload profile preset.
        label: 'New RAG cluster',
        to: `${CNPG}/create?profile=vector`,
        isActive: isRagCreate,
      },
    ],
  },
  {
    title: 'Security',
    items: [
      {
        label: 'Audit logs',
        to: `${CNPG}/audit`,
        isActive: p => p.startsWith(`${CNPG}/audit`),
      },
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
      <Link to={CNPG} className="tp-nav__brand" aria-label="Home">
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
