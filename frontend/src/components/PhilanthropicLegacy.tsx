import { signOut } from '../auth/cognito';
import { AppHeader, type View } from './AppHeader';

interface Props {
  clientName: string;
  attribution?: string;
  description?: string;
  onSignOut: () => void;
  onBack?: () => void;
  onNavigate: (view: View) => void;
}

function defaultDescription(clientName: string): string {
  return `A recorded conversation, separate from the main interview, capturing ${clientName}’s ` +
    'giving values, motivations, and wishes for the family’s continued philanthropy.';
}

const NEUTRAL_DESCRIPTION =
  'Recorded privately for her family and designated trustee. Her values, motivations, and wishes ' +
  'for the causes she cared about most.';

function descriptionText(clientName: string, attribution: string | undefined, description: string | undefined): string {
  if (!attribution) return NEUTRAL_DESCRIPTION;
  return description ?? defaultDescription(clientName);
}

export function PhilanthropicLegacy({ clientName, attribution, description, onSignOut, onBack, onNavigate }: Props) {
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
        <button type="button" className="philanthropic-back-link" onClick={() => onNavigate('ask')}>
          ← Back to Dashboard
        </button>

        <div className="philanthropic-video-wrap">
          <span className="philanthropic-preview-badge">Concept Preview</span>

          <div className="philanthropic-play-overlay">
            <svg className="philanthropic-play-icon" viewBox="0 0 80 80" fill="none" aria-hidden="true">
              <circle cx="40" cy="40" r="38" fill="rgba(15,30,46,0.35)" stroke="rgba(255,255,255,0.55)" strokeWidth="2" />
              <path d="M33 27l22 13-22 13V27z" fill="white" />
            </svg>
          </div>

          <div className="philanthropic-video-caption">{clientName} — On Giving Back</div>
          <div className="philanthropic-video-duration">24:10</div>
        </div>

        <div className="philanthropic-title-row">
          <h1 className="philanthropic-title">{clientName}&rsquo;s Philanthropic Legacy</h1>
          {attribution ? <span className="philanthropic-attribution-badge">{attribution}</span> : null}
        </div>

        <p className="philanthropic-description">{descriptionText(clientName, attribution, description)}</p>

        <div className="philanthropic-callout">
          <svg className="philanthropic-callout-icon" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path d="M16 4L6 9v8l10 6 10-6V9L16 4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
          <p>
            Kept in its own secure space, separate from The Trust Voice&rsquo;s Q&amp;A vault. This
            recording is never used to answer a trustee&rsquo;s questions about the trust itself.
          </p>
        </div>
      </div>
    </div>
  );
}
