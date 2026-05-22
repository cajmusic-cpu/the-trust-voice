import { useState, useEffect, type FormEvent } from 'react';
import QRCode from 'qrcode';
import type { CognitoUser } from 'amazon-cognito-identity-js';
import { associateSoftwareToken, verifySoftwareToken } from '../auth/cognito';

interface Props {
  user: CognitoUser;
  email: string;
  onSuccess: () => void;
  onBack: () => void;
}

export function TotpSetupForm({ user, email, onSuccess, onBack }: Props) {
  const [secret, setSecret] = useState('');
  const [qrUrl, setQrUrl] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [fetchingSecret, setFetchingSecret] = useState(true);

  useEffect(() => {
    associateSoftwareToken(user)
      .then(async s => {
        setSecret(s);
        const otpauth = `otpauth://totp/TheTrustVoice:${encodeURIComponent(email)}?secret=${s}&issuer=TheTrustVoice`;
        const url = await QRCode.toDataURL(otpauth, { width: 200, margin: 1 });
        setQrUrl(url);
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to initialize authenticator'))
      .finally(() => setFetchingSecret(false));
  }, [user, email]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await verifySoftwareToken(user, code);
      onSuccess();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Verification failed';
      setError(msg.includes('Code mismatch') ? 'Incorrect code — check your authenticator app and try again.' : msg);
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
      <h1 className="auth-title">Set up two-factor authentication</h1>
      <p className="auth-subtitle">Scan the QR code with your authenticator app, then enter the code to confirm.</p>

      {fetchingSecret ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '24px' }}>
          <div className="spinner" />
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="auth-form">
          {qrUrl && (
            <div className="totp-qr">
              <img src={qrUrl} alt="Scan with your authenticator app" width={160} height={160} />
            </div>
          )}
          {secret && (
            <div className="totp-secret">
              <span className="totp-secret-label">Or enter manually:</span>
              <code className="totp-secret-code">{secret}</code>
            </div>
          )}
          <div className="field">
            <label htmlFor="totp-code">Confirmation code</label>
            <input
              id="totp-code"
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
            {loading ? 'Verifying…' : 'Confirm and continue'}
          </button>
          <button type="button" className="btn-ghost" onClick={onBack}>
            ← Back to sign in
          </button>
        </form>
      )}
    </div>
  );
}
