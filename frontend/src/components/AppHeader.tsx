// Shared top bar for the authenticated views (QueryInterface, ExploreByTopic,
// and the entitlement-gated PhilanthropicLegacy).
// Extracted so the "Explore by Topic" nav item is reachable from anywhere per
// the source doc's requirement #3 — a trustee is never more than one click
// from either view. Structural extraction only: brand/client-badge/sign-out
// markup is unchanged from QueryInterface's original inline header.

export type View = 'ask' | 'explore' | 'philanthropic';

interface Props {
  clientName: string;
  view: View;
  onNavigate: (view: View) => void;
  onSignOut: () => void;
  onBack?: () => void;
  // Entitlement-gated: the tab renders only for accounts with the module
  // turned on. No visible-but-inactive tab for accounts without it.
  showPhilanthropicLegacy?: boolean;
}

export function AppHeader({ clientName, view, onNavigate, onSignOut, onBack, showPhilanthropicLegacy }: Props) {
  return (
    <header className="top-bar">
      <div className="top-bar-left">
        {onBack && (
          <button className="btn-ghost-sm" onClick={onBack}>← Estates</button>
        )}
        <div className="top-bar-brand">
          <svg width="24" height="24" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="#1B2E45" />
            <path d="M16 7L7 12v8l9 5 9-5v-8L16 7z" stroke="white" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
            <path d="M16 7v13M7 12l9 5 9-5" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
          <span>The Trust Voice</span>
        </div>
        <nav className="nav-tabs" aria-label="View">
          <button
            type="button"
            className={`nav-tab${view === 'ask' ? ' nav-tab--active' : ''}`}
            aria-current={view === 'ask' ? 'page' : undefined}
            onClick={() => onNavigate('ask')}
          >
            Ask a Question
          </button>
          <button
            type="button"
            className={`nav-tab${view === 'explore' ? ' nav-tab--active' : ''}`}
            aria-current={view === 'explore' ? 'page' : undefined}
            onClick={() => onNavigate('explore')}
          >
            Explore by Topic
          </button>
          {showPhilanthropicLegacy && (
            <button
              type="button"
              className={`nav-tab${view === 'philanthropic' ? ' nav-tab--active' : ''}`}
              aria-current={view === 'philanthropic' ? 'page' : undefined}
              onClick={() => onNavigate('philanthropic')}
            >
              Philanthropic Legacy
              <span className="nav-badge">New</span>
            </button>
          )}
        </nav>
      </div>
      <div className="top-bar-right">
        <span className="client-badge">{clientName}</span>
        <button className="btn-ghost-sm" onClick={onSignOut}>Sign out</button>
      </div>
    </header>
  );
}
