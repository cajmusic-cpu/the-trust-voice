import { useState, useEffect, useCallback } from 'react';
import {
  signIn,
  confirmSignIn,
  signOut as cognitoSignOut,
  type SignInResult,
} from './auth/cognito';
import { getClients, type Client } from './api/client';
import { LoginForm } from './components/LoginForm';
import { MfaForm } from './components/MfaForm';
import { NewPasswordForm } from './components/NewPasswordForm';
import { TotpSetupForm } from './components/TotpSetupForm';
import { ClientSelector } from './components/ClientSelector';
import { QueryInterface } from './components/QueryInterface';

type Screen =
  | { id: 'loading' }
  | { id: 'login' }
  | { id: 'mfa' }
  | { id: 'totp_setup'; secret: string; email: string }
  | { id: 'new_password' }
  | { id: 'client_select'; clients: Client[] }
  | { id: 'query'; client: Client; clients: Client[] };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ id: 'loading' });
  const [pendingEmail, setPendingEmail] = useState('');

  const INACTIVITY_MS = 30 * 60 * 1000;
  const authenticated = screen.id === 'client_select' || screen.id === 'query';

  const forceSignOut = useCallback(() => {
    void cognitoSignOut();
    setScreen({ id: 'login' });
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(forceSignOut, INACTIVITY_MS);
    };
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'] as const;
    events.forEach(e => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach(e => window.removeEventListener(e, reset));
    };
  }, [authenticated, forceSignOut]);

  // On mount: always require fresh authentication — clear any stored session so
  // tokens left from a previous visit cannot bypass login + MFA.
  useEffect(() => {
    void cognitoSignOut();
    setScreen({ id: 'login' });
  }, []);

  async function loadClients(): Promise<void> {
    const clients = await getClients();
    if (clients.length === 1) {
      setScreen({ id: 'query', client: clients[0], clients });
    } else {
      setScreen({ id: 'client_select', clients });
    }
  }

  // Routes an Amplify sign-in / confirm-sign-in outcome to the next screen.
  async function applySignInResult(result: SignInResult): Promise<void> {
    switch (result.status) {
      case 'authenticated':
        return loadClients();
      case 'mfa_required':
        setScreen({ id: 'mfa' });
        return;
      case 'totp_setup':
        setScreen({ id: 'totp_setup', secret: result.secret, email: pendingEmail });
        return;
      case 'new_password_required':
        setScreen({ id: 'new_password' });
        return;
    }
  }

  async function handleLogin(email: string, password: string): Promise<void> {
    setPendingEmail(email);
    await applySignInResult(await signIn(email, password));
  }

  async function handleMfa(code: string): Promise<void> {
    await applySignInResult(await confirmSignIn(code));
  }

  async function handleTotpSetup(code: string): Promise<void> {
    await applySignInResult(await confirmSignIn(code));
  }

  async function handleNewPassword(newPassword: string): Promise<void> {
    await applySignInResult(await confirmSignIn(newPassword));
  }

  function handleSignOut(): void {
    void cognitoSignOut();
    setScreen({ id: 'login' });
  }

  function handleSelectClient(client: Client): void {
    if (screen.id !== 'client_select') return;
    setScreen({ id: 'query', client, clients: screen.clients });
  }

  function handleBackToSelector(): void {
    if (screen.id !== 'query') return;
    setScreen({ id: 'client_select', clients: screen.clients });
  }

  if (screen.id === 'loading') {
    return (
      <div className="loading-screen">
        <div className="spinner" />
      </div>
    );
  }

  if (screen.id === 'login') {
    return (
      <div className="auth-screen">
        <LoginForm onSuccess={handleLogin} />
      </div>
    );
  }

  if (screen.id === 'mfa') {
    return (
      <div className="auth-screen">
        <MfaForm
          onSuccess={handleMfa}
          onBack={() => setScreen({ id: 'login' })}
        />
      </div>
    );
  }

  if (screen.id === 'totp_setup') {
    return (
      <div className="auth-screen">
        <TotpSetupForm
          secret={screen.secret}
          email={screen.email || pendingEmail}
          onSuccess={handleTotpSetup}
          onBack={() => setScreen({ id: 'login' })}
        />
      </div>
    );
  }

  if (screen.id === 'new_password') {
    return (
      <div className="auth-screen">
        <NewPasswordForm
          onSuccess={handleNewPassword}
          onBack={() => setScreen({ id: 'login' })}
        />
      </div>
    );
  }

  if (screen.id === 'client_select') {
    return (
      <ClientSelector
        clients={screen.clients}
        onSelect={handleSelectClient}
        onSignOut={handleSignOut}
      />
    );
  }

  // screen.id === 'query'
  return (
    <QueryInterface
      clientId={screen.client.id}
      clientName={screen.client.name}
      onSignOut={handleSignOut}
      onBack={screen.clients.length > 1 ? handleBackToSelector : undefined}
    />
  );
}
