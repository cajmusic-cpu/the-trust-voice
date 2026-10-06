import { useState, type FormEvent } from 'react';

interface Props {
  onSuccess: (email: string, password: string) => Promise<void>;
}

export function LoginForm({ onSuccess }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await onSuccess(email, password);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-card">
      <div className="auth-logo">
        <h1 className="auth-wordmark brand-wordmark">The <span>Trust</span> Voice</h1>
      </div>
      <p className="auth-subtitle">Trustee Portal</p>

      <form onSubmit={handleSubmit} className="auth-form">
        <div className="field">
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <p className="form-error">{error}</p>}
        <button type="submit" className="btn-primary" disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

function friendlyError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : 'Sign in failed';
  if (name === 'UserNotFoundException') return 'Incorrect email or password.';
  if (name === 'NotAuthorizedException') {
    if (msg.includes('disabled')) return 'This account has been disabled. Contact your administrator.';
    if (msg.toLowerCase().includes('attempts')) {
      return 'Too many failed attempts. Please wait a few minutes and try again.';
    }
    return 'Incorrect email or password.';
  }
  if (
    name === 'LimitExceededException' ||
    name === 'TooManyRequestsException' ||
    name === 'TooManyFailedAttemptsException'
  ) {
    return 'Too many attempts. Please wait a few minutes and try again.';
  }
  // Message-only fallbacks
  if (msg.includes('Incorrect username or password') || msg.includes('User does not exist')) {
    return 'Incorrect email or password.';
  }
  return msg;
}
