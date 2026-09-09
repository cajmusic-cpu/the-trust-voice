import { useState, useEffect, type FormEvent } from 'react';
import QRCode from 'qrcode';

interface Props {
  /** Base32 TOTP shared secret from the CONTINUE_SIGN_IN_WITH_TOTP_SETUP step. */
  secret: string;
  email: string;
  onSuccess: (code: string) => Promise<void>;
  onBack: () => void;
}

export function TotpSetupForm({ secret, email, onSuccess, onBack }: Props) {
  const [qrUrl, setQrUrl] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const otpauth =
      `otpauth://totp/TheTrustVoice:${encodeURIComponent(email)}` +
      `?secret=${secret}&issuer=TheTrustVoice`;
    QRCode.toDataURL(otpauth, { width: 200, margin: 1 })
      .then(setQrUrl)
      .catch(() => setQrUrl(''));
  }, [secret, email]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await onSuccess(code);
    } catch (err) {
      setError(friendlyCodeError(err));
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

      <form onSubmit={handleSubmit} className="auth-form">
        {qrUrl && (
          <div className="totp-qr">
            <img src={qrUrl} alt="Scan with your authenticator app" width={160} height={160} />
          </div>
        )}
        <div className="totp-secret">
          <span className="totp-secret-label">Or enter manually:</span>
          <code className="totp-secret-code">{secret}</code>
        </div>
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
    </div>
  );
}

function friendlyCodeError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'CodeMismatchException' || name === 'EnableSoftwareTokenMFAException') {
    return 'Incorrect code — check your authenticator app and try again.';
  }
  if (name === 'ExpiredCodeException') {
    return 'That code has expired. Enter the current one from your app.';
  }
  return err instanceof Error ? err.message : 'Verification failed';
}
