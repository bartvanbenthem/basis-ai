import { SignInPageBlueprint } from '@backstage/plugin-app-react';
import { BasisLogo } from './BasisLogo';

/** The default guest sign-in, centred and branded. */
export const BasisSignInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => {
      const { SignInPage } = await import('@backstage/core-components');
      return props => (
        <SignInPage
          {...props}
          providers={['guest']}
          align="center"
          titleComponent={<BasisLogo height={34} />}
        />
      );
    },
  },
});
