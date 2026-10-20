import { ThemeBlueprint } from '@backstage/plugin-app-react';
import {
  createUnifiedTheme,
  genPageTheme,
  pageTheme as defaultPageThemes,
  palettes,
  UnifiedThemeProvider,
} from '@backstage/theme';

/** Tuskpilot brand colours; mirrored as CSS tokens in ./tuskpilot.css for Backstage UI. */
export const tp = {
  green: '#00c300',
  bg: '#0e0f13',
  surface: '#16181f',
  surfaceRaised: '#1d2029',
  border: '#272a35',
  text: '#e9ebf0',
  textMuted: '#9197a6',
};

// Backstage's MUI page headers (sign-in, catalog pages) become a flat dark bar.
const flat = genPageTheme({
  colors: [tp.surface, tp.surface],
  shape: 'none',
});
const pageTheme = Object.fromEntries(
  Object.keys(defaultPageThemes).map(k => [k, flat]),
);

const theme = createUnifiedTheme({
  palette: {
    ...palettes.dark,
    primary: { main: tp.green },
    secondary: { main: tp.green },
    background: { default: tp.bg, paper: tp.surface },
    text: { primary: tp.text, secondary: tp.textMuted },
    link: tp.green,
    linkHover: '#33d633',
    navigation: {
      ...palettes.dark.navigation,
      background: tp.surface,
      indicator: tp.green,
      color: tp.textMuted,
      selectedColor: tp.text,
    },
  },
  pageTheme,
  defaultPageTheme: 'home',
});

/**
 * The only theme in the portal. The `data-theme-name="tuskpilot"` attribute it sets
 * on <body> scopes the Backstage UI token overrides in ./tuskpilot.css.
 */
export const tuskpilotTheme = ThemeBlueprint.make({
  name: 'tuskpilot',
  params: {
    theme: {
      id: 'tuskpilot',
      title: 'Tuskpilot',
      variant: 'dark',
      Provider: ({ children }) => (
        <UnifiedThemeProvider theme={theme} themeName="tuskpilot">
          {children}
        </UnifiedThemeProvider>
      ),
    },
  },
});
