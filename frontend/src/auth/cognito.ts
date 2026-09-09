import { Amplify } from 'aws-amplify';
import {
  signIn as amplifySignIn,
  confirmSignIn as amplifyConfirmSignIn,
  signOut as amplifySignOut,
  fetchAuthSession,
  type SignInOutput,
} from 'aws-amplify/auth';
import { cognitoUserPoolsTokenProvider } from 'aws-amplify/auth/cognito';
import { sessionStorage as amplifySessionStorage } from 'aws-amplify/utils';

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env['VITE_USER_POOL_ID'] as string,
      userPoolClientId: import.meta.env['VITE_USER_POOL_CLIENT_ID'] as string,
      // No `loginWith`/OAuth block on purpose — this app uses SRP, not the
      // hosted UI. Keeping OAuth unconfigured also keeps signOut() on the
      // clean token-clearing path (see the migration notes / PR).
    },
  },
});

// Persist Cognito tokens in sessionStorage rather than the v6 default of
// localStorage: tokens are dropped when the tab or window closes, which
// reinforces the "require fresh authentication on every visit" rule
// (App.tsx also calls signOut() on mount as a second layer).
cognitoUserPoolsTokenProvider.setKeyValueStorage(amplifySessionStorage);

export type SignInResult =
  | { status: 'authenticated' }
  | { status: 'mfa_required' }
  | { status: 'totp_setup'; secret: string }
  | { status: 'new_password_required' };

// Maps an Amplify v6 sign-in / confirm-sign-in result to the app's screen model.
function toSignInResult(output: SignInOutput): SignInResult {
  if (output.isSignedIn) return { status: 'authenticated' };

  const { nextStep } = output;
  switch (nextStep.signInStep) {
    case 'DONE':
      return { status: 'authenticated' };
    case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE':
      return { status: 'mfa_required' };
    case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP':
      return { status: 'totp_setup', secret: nextStep.totpSetupDetails.sharedSecret };
    case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
      return { status: 'new_password_required' };
    default:
      // The pool is TOTP-only MFA with admin-created users, so no other step
      // should occur. Surface it rather than silently stalling.
      throw new Error(`Unsupported sign-in step: ${nextStep.signInStep}`);
  }
}

export async function signIn(email: string, password: string): Promise<SignInResult> {
  const username = email.trim().toLowerCase();
  try {
    return toSignInResult(await amplifySignIn({ username, password }));
  } catch (err) {
    // A stale in-memory session from a previous attempt can block a fresh
    // sign-in; clear it and retry once.
    if (err instanceof Error && err.name === 'UserAlreadyAuthenticatedException') {
      await signOut();
      return toSignInResult(await amplifySignIn({ username, password }));
    }
    throw err;
  }
}

// Continues a pending challenge: TOTP code, new password, or TOTP-setup code.
// Amplify v6 tracks which challenge is outstanding internally.
export async function confirmSignIn(response: string): Promise<SignInResult> {
  return toSignInResult(await amplifyConfirmSignIn({ challengeResponse: response.trim() }));
}

// Current idToken as a raw JWT string. fetchAuthSession refreshes it silently
// when it has expired and the refresh token is still valid.
export async function getIdToken(): Promise<string> {
  const { tokens } = await fetchAuthSession();
  const idToken = tokens?.idToken?.toString();
  if (!idToken) throw new Error('Not signed in');
  return idToken;
}

// Global sign-out: revokes every refresh token for the user (Cognito
// GlobalSignOut) and clears local tokens. Amplify clears local storage even
// when the network call fails, so a best-effort catch here is enough.
export async function signOut(): Promise<void> {
  try {
    await amplifySignOut({ global: true });
  } catch {
    /* local tokens are still cleared by Amplify on failure */
  }
}
