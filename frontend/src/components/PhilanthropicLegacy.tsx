import { signOut } from '../auth/cognito';
import { AppHeader, type View } from './AppHeader';

interface Props {
  clientName: string;
  attribution?: string;
  onSignOut: () => void;
  onBack?: () => void;
  onNavigate: (view: View) => void;
}

export function PhilanthropicLegacy({ clientName, attribution, onSignOut, onBack, onNavigate }: Props) {
  function handleSignOut() {
    void signOut();
    onSignOut();
  }

  return (
    <div className="query-page">
      <AppHeader
        clientName={clientName}
        view="philanthropic"
        onNavigate={onNavigate}
        onSignOut={handleSignOut}
        onBack={onBack}
        showPhilanthropicLegacy
      />

      <div className="philanthropic-page">
        <p className="empty-title philanthropic-title">{clientName}&rsquo;s Philanthropic Legacy</p>
        {attribution && <p className="philanthropic-attribution">{attribution}</p>}

        <div className="philanthropic-video-wrap">
          <div className="philanthropic-play-overlay">
            <svg className="citation-play-icon" viewBox="0 0 80 80" fill="none" aria-hidden="true">
              <circle cx="40" cy="40" r="40" fill="rgba(15,30,46,0.6)" />
              <path d="M32 26l24 14-24 14V26z" fill="white" />
            </svg>
          </div>
          <div className="citation-clip-badge">4:12</div>
        </div>

        <p className="philanthropic-description">
          A recorded conversation, separate from the main interview, capturing {clientName}&rsquo;s
          giving values, motivations, and wishes for the family&rsquo;s continued philanthropy.
        </p>

        <div className="philanthropic-callout">
          Kept in its own secure space, separate from The Trust Voice&rsquo;s Q&amp;A vault. This
          recording is never used to answer a trustee&rsquo;s questions about the trust itself.
        </div>

        <button type="button" className="btn-ghost philanthropic-back" onClick={() => onNavigate('ask')}>
          ← Back to Dashboard
        </button>
      </div>
    </div>
  );
}
