import {
  coreExtensionData,
  createExtension,
  createExtensionInput,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import { Navigate } from 'react-router-dom';

/**
 * Replaces app/layout (Backstage's collapsible SidebarPage) with a fixed
 * two-column shell: sidebar on the left, scrolling content on the right.
 */
export const AppShell = createExtension({
  name: 'layout',
  attachTo: { id: 'app/root', input: 'children' },
  inputs: {
    nav: createExtensionInput([coreExtensionData.reactElement], {
      singleton: true,
    }),
    content: createExtensionInput([coreExtensionData.reactElement], {
      singleton: true,
    }),
  },
  output: [coreExtensionData.reactElement],
  factory: ({ inputs }) => [
    coreExtensionData.reactElement(
      <div className="tp-shell">
        {inputs.nav.get(coreExtensionData.reactElement)}
        <main className="tp-shell__main">
          {inputs.content.get(coreExtensionData.reactElement)}
        </main>
      </div>,
    ),
  ],
});

/** "/" lands on the GenAI stacks: AI services first. */
export const RootRedirect = PageBlueprint.make({
  name: 'root',
  params: {
    path: '/',
    noHeader: true,
    loader: async () => <Navigate to="/basis/stacks" replace />,
  },
});
