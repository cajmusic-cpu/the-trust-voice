import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserSession,
} from 'amazon-cognito-identity-js';

const pool = new CognitoUserPool({
  UserPoolId: import.meta.env['VITE_USER_POOL_ID'] as string,
  ClientId: import.meta.env['VITE_USER_POOL_CLIENT_ID'] as string,
});

export type SignInResult =
  | { status: 'authenticated'; session: CognitoUserSession }
  | { status: 'mfa_required'; user: CognitoUser }
  | { status: 'totp_setup'; user: CognitoUser }
  | { status: 'new_password_required'; user: CognitoUser };

export async function signIn(email: string, password: string): Promise<SignInResult> {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: email.trim().toLowerCase(), Pool: pool });
    const authDetails = new AuthenticationDetails({
      Username: email.trim().toLowerCase(),
      Password: password,
    });

    user.authenticateUser(authDetails, {
      onSuccess(session) {
        resolve({ status: 'authenticated', session });
      },
      onFailure(err) {
        reject(err);
      },
      totpRequired() {
        resolve({ status: 'mfa_required', user });
      },
      mfaRequired() {
        resolve({ status: 'mfa_required', user });
      },
      newPasswordRequired() {
        resolve({ status: 'new_password_required', user });
      },
      mfaSetup() {
        resolve({ status: 'totp_setup', user });
      },
    });
  });
}

export async function confirmMfa(user: CognitoUser, code: string): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    user.sendMFACode(
      code.trim(),
      { onSuccess: resolve, onFailure: reject },
      'SOFTWARE_TOKEN_MFA',
    );
  });
}

export async function completeNewPassword(
  user: CognitoUser,
  newPassword: string,
): Promise<SignInResult> {
  return new Promise((resolve, reject) => {
    user.completeNewPasswordChallenge(newPassword, {}, {
      onSuccess(session) {
        resolve({ status: 'authenticated', session });
      },
      onFailure(err) {
        reject(err);
      },
      totpRequired() {
        resolve({ status: 'mfa_required', user });
      },
      mfaSetup() {
        resolve({ status: 'totp_setup', user });
      },
    });
  });
}

// Retrieves the current idToken, refreshing silently if it has expired.
export async function getIdToken(): Promise<string> {
  const user = pool.getCurrentUser();
  if (!user) throw new Error('Not signed in');
  return new Promise((resolve, reject) => {
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session?.isValid()) return reject(err ?? new Error('Session expired'));
      resolve(session.getIdToken().getJwtToken());
    });
  });
}

// Returns true if there is a locally stored valid session (no network call).
export async function hasStoredSession(): Promise<boolean> {
  const user = pool.getCurrentUser();
  if (!user) return false;
  return new Promise(resolve => {
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      resolve(!err && session !== null && session.isValid());
    });
  });
}

// Step 1 of TOTP setup: get the base32 secret from Cognito.
export async function associateSoftwareToken(user: CognitoUser): Promise<string> {
  return new Promise((resolve, reject) => {
    user.associateSoftwareToken({
      associateSecretCode: resolve,
      onFailure: reject,
    });
  });
}

// Step 2 of TOTP setup: confirm the secret with the first code from the auth app.
export async function verifySoftwareToken(
  user: CognitoUser,
  code: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    user.verifySoftwareToken(code.trim(), 'Authenticator app', {
      onSuccess: () => resolve(),
      onFailure: reject,
    });
  });
}

export function signOut(): void {
  pool.getCurrentUser()?.signOut();
}
