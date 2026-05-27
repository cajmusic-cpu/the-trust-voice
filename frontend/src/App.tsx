import { useState, useEffect, useCallback } from 'react';
import type { CognitoUser } from 'amazon-cognito-identity-js';
import { signIn, confirmMfa, completeNewPassword, hasStoredSession, signOut as cognitoSignOut } from './auth/cognito';
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
  | { id: 'mfa'; user: CognitoUser }
  | { id: 'totp_setup'; user: CognitoUser; email: string }
  | { id: 'new_password'; user: CognitoUser }
  | { id: 'client_select'; clients: Client[] }
  | { id: 'query'; client: Client; clients: Client[] };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ id: 'loading' });
  const [pendingEmail, setPendingEmail] = useState('');

  const INACTIVITY_MS = 30 * 60 * 1000;
  const authenticated = screen.id === 'client_select' || screen.id === 'query';

  const forceSignOut = useCallback(() => {
    cognitoSignOut();
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

  // On mount: check for a stored Cognito session so returning users skip login.
  useEffect(() => {
    hasStoredSession()
      .then(valid => {
        if (valid) return loadClients();
        setScreen({ id: 'login' });
      })
      .catch(() => setScreen({ id: 'login' }));
  }, []);

  async function loadClients(): Promise<void> {
    const clients = await getClients();
    if (clients.length === 1) {
      setScreen({ id: 'query', client: clients[0], clients });
    } else {
      setScreen({ id: 'client_select', clients });
    }
  }

  async function handleLogin(email: string, password: string): Promise<void> {
    setPendingEmail(email);
    const result = await signIn(email, password);
    if (result.status === 'authenticated') {
      await loadClients();
    } else if (result.status === 'mfa_required') {
      setScreen({ id: 'mfa', user: result.user });
    } else if (result.status === 'totp_setup') {
      setScreen({ id: 'totp_setup', user: result.user, email });
    } else {
      setScreen({ id: 'new_password', user: result.user });
    }
  }

  async function handleMfa(code: string): Promise<void> {
    if (screen.id !== 'mfa') return;
    await confirmMfa(screen.user, code);
    await loadClients();
  }

  async function handleTotpSetupDone(): Promise<void> {
    // After TOTP verification, Cognito completes the session — load clients.
    await loadClients();
  }

  async function handleNewPassword(newPassword: string): Promise<void> {
    if (screen.id !== 'new_password') return;
    const result = await completeNewPassword(screen.user, newPassword);
    if (result.status === 'mfa_required') {
      setScreen({ id: 'mfa', user: result.user });
    } else if (result.status === 'totp_setup') {
      setScreen({ id: 'totp_setup', user: result.user, email: pendingEmail });
    } else {
      await loadClients();
    }
  }

  function handleSignOut(): void {
    cognitoSignOut();
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
          user={screen.user}
          email={screen.email || pendingEmail}
          onSuccess={handleTotpSetupDone}
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
