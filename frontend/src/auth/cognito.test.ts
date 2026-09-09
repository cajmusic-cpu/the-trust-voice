import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every Amplify module cognito.ts touches at import time or runtime.
// vi.hoisted keeps these usable inside the hoisted vi.mock factories.
const {
  mockSignIn,
  mockConfirmSignIn,
  mockSignOut,
  mockFetchAuthSession,
  mockConfigure,
  mockSetKeyValueStorage,
} = vi.hoisted(() => ({
  mockSignIn: vi.fn(),
  mockConfirmSignIn: vi.fn(),
  mockSignOut: vi.fn(),
  mockFetchAuthSession: vi.fn(),
  mockConfigure: vi.fn(),
  mockSetKeyValueStorage: vi.fn(),
}));

vi.mock('aws-amplify', () => ({ Amplify: { configure: mockConfigure } }));
vi.mock('aws-amplify/auth', () => ({
  signIn: mockSignIn,
  confirmSignIn: mockConfirmSignIn,
  signOut: mockSignOut,
  fetchAuthSession: mockFetchAuthSession,
}));
vi.mock('aws-amplify/auth/cognito', () => ({
  cognitoUserPoolsTokenProvider: { setKeyValueStorage: mockSetKeyValueStorage },
}));
vi.mock('aws-amplify/utils', () => ({ sessionStorage: { __tag: 'sessionStorage' } }));

// Import after the mocks are registered.
import { signIn, confirmSignIn, getIdToken, signOut } from './cognito';

// Reset only the per-call mocks between tests; leave the import-time
// Amplify.configure / setKeyValueStorage call records intact for the
// configuration assertion below.
beforeEach(() => {
  mockSignIn.mockReset();
  mockConfirmSignIn.mockReset();
  mockSignOut.mockReset();
  mockFetchAuthSession.mockReset();
});

it('configures Amplify and pins token storage to sessionStorage at import', () => {
  expect(mockConfigure).toHaveBeenCalledWith(
    expect.objectContaining({
      Auth: { Cognito: expect.objectContaining({ userPoolId: expect.any(String) }) },
    }),
  );
  expect(mockSetKeyValueStorage).toHaveBeenCalledWith({ __tag: 'sessionStorage' });
});

describe('signIn', () => {
  it('normalizes the username and maps a completed sign-in', async () => {
    mockSignIn.mockResolvedValueOnce({ isSignedIn: true, nextStep: { signInStep: 'DONE' } });
    const res = await signIn('  Trustee@Example.COM ', 'pw');
    expect(mockSignIn).toHaveBeenCalledWith({ username: 'trustee@example.com', password: 'pw' });
    expect(res).toEqual({ status: 'authenticated' });
  });

  it('maps CONFIRM_SIGN_IN_WITH_TOTP_CODE → mfa_required', async () => {
    mockSignIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' },
    });
    expect(await signIn('a@b.co', 'pw')).toEqual({ status: 'mfa_required' });
  });

  it('maps CONTINUE_SIGN_IN_WITH_TOTP_SETUP → totp_setup with the shared secret', async () => {
    mockSignIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: {
        signInStep: 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP',
        totpSetupDetails: { sharedSecret: 'JBSWY3DPEHPK3PXP', getSetupUri: () => new URL('otpauth://x') },
      },
    });
    expect(await signIn('a@b.co', 'pw')).toEqual({
      status: 'totp_setup',
      secret: 'JBSWY3DPEHPK3PXP',
    });
  });

  it('maps CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED → new_password_required', async () => {
    mockSignIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' },
    });
    expect(await signIn('a@b.co', 'pw')).toEqual({ status: 'new_password_required' });
  });

  it('throws on an unsupported sign-in step', async () => {
    mockSignIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_SMS_CODE' },
    });
    await expect(signIn('a@b.co', 'pw')).rejects.toThrow(/Unsupported sign-in step/);
  });

  it('clears a stale session and retries once on UserAlreadyAuthenticatedException', async () => {
    const already = Object.assign(new Error('already'), { name: 'UserAlreadyAuthenticatedException' });
    mockSignIn
      .mockRejectedValueOnce(already)
      .mockResolvedValueOnce({ isSignedIn: true, nextStep: { signInStep: 'DONE' } });
    mockSignOut.mockResolvedValueOnce(undefined);

    const res = await signIn('a@b.co', 'pw');

    expect(mockSignOut).toHaveBeenCalledWith({ global: true });
    expect(mockSignIn).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ status: 'authenticated' });
  });

  it('propagates ordinary sign-in errors (wrong password)', async () => {
    mockSignIn.mockRejectedValueOnce(
      Object.assign(new Error('Incorrect username or password.'), { name: 'NotAuthorizedException' }),
    );
    await expect(signIn('a@b.co', 'bad')).rejects.toThrow('Incorrect username or password.');
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});

describe('confirmSignIn', () => {
  it('trims the response and maps a completed challenge', async () => {
    mockConfirmSignIn.mockResolvedValueOnce({ isSignedIn: true, nextStep: { signInStep: 'DONE' } });
    const res = await confirmSignIn(' 123456 ');
    expect(mockConfirmSignIn).toHaveBeenCalledWith({ challengeResponse: '123456' });
    expect(res).toEqual({ status: 'authenticated' });
  });

  it('routes a new-password confirm that still needs MFA', async () => {
    mockConfirmSignIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' },
    });
    expect(await confirmSignIn('NewPassw0rd!')).toEqual({ status: 'mfa_required' });
  });
});

describe('getIdToken', () => {
  it('returns the raw idToken JWT string', async () => {
    mockFetchAuthSession.mockResolvedValueOnce({
      tokens: { idToken: { toString: () => 'header.payload.sig' } },
    });
    expect(await getIdToken()).toBe('header.payload.sig');
  });

  it('throws when there is no session', async () => {
    mockFetchAuthSession.mockResolvedValueOnce({ tokens: undefined });
    await expect(getIdToken()).rejects.toThrow('Not signed in');
  });
});

describe('signOut', () => {
  it('performs a global sign-out', async () => {
    mockSignOut.mockResolvedValueOnce(undefined);
    await signOut();
    expect(mockSignOut).toHaveBeenCalledWith({ global: true });
  });

  it('never rejects even if the network revoke fails', async () => {
    mockSignOut.mockRejectedValueOnce(new Error('network down'));
    await expect(signOut()).resolves.toBeUndefined();
  });
});
