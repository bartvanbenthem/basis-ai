import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { basisTheme } from '../theme';
import { AppShell, RootRedirect } from './AppShell';
import { BasisSignInPage } from './SignIn';
import { SidebarContent } from './Sidebar';

export const navModule = createFrontendModule({
  pluginId: 'app',
  extensions: [
    SidebarContent,
    AppShell,
    RootRedirect,
    BasisSignInPage,
    basisTheme,
  ],
});
