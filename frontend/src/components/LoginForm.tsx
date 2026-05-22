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
      const msg = err instanceof Error ? err.message : 'Sign in failed';
      setError(friendlyError(msg));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-card">
      <div className="auth-logo">
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
          <rect width="32" height="32" rx="8" fill="#1e3a5f" />
          <path d="M16 7L7 12v8l9 5 9-5v-8L16 7z" stroke="white" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
          <path d="M16 7v13M7 12l9 5 9-5" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      </div>
      <h1 className="auth-title">The Trust Voice</h1>
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

function friendlyError(msg: string): string {
  if (msg.includes('Incorrect username or password')) return 'Incorrect email or password.';
  if (msg.includes('User is disabled')) return 'This account has been disabled. Contact your administrator.';
  if (msg.includes('User does not exist')) return 'Incorrect email or password.';
  if (msg.includes('Password attempts exceeded')) return 'Too many failed attempts. Please wait a few minutes and try again.';
  return msg;
}
