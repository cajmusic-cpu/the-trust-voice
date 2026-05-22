import { useState, type FormEvent } from 'react';

interface Props {
  onSuccess: (code: string) => Promise<void>;
  onBack: () => void;
}

export function MfaForm({ onSuccess, onBack }: Props) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await onSuccess(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Verification failed';
      setError(msg.includes('Code mismatch') ? 'Incorrect code. Please try again.' : msg);
      setCode('');
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
      <h1 className="auth-title">Two-factor authentication</h1>
      <p className="auth-subtitle">Enter the 6-digit code from your authenticator app</p>

      <form onSubmit={handleSubmit} className="auth-form">
        <div className="field">
          <label htmlFor="mfa-code">Verification code</label>
          <input
            id="mfa-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
            placeholder="000000"
            className="code-input"
            required
            autoFocus
          />
        </div>
        {error && <p className="form-error">{error}</p>}
        <button type="submit" className="btn-primary" disabled={loading || code.length !== 6}>
          {loading ? 'Verifying…' : 'Verify'}
        </button>
        <button type="button" className="btn-ghost" onClick={onBack}>
          ← Back to sign in
        </button>
      </form>
    </div>
  );
}
