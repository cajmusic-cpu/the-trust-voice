import type { Client } from '../api/client';

interface Props {
  clients: Client[];
  onSelect: (client: Client) => void;
  onSignOut: () => void;
}

export function ClientSelector({ clients, onSelect, onSignOut }: Props) {
  return (
    <div className="page-centered">
      <header className="top-bar">
        <div className="top-bar-brand">
          <svg width="24" height="24" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="#1B2E45" />
            <path d="M16 7L7 12v8l9 5 9-5v-8L16 7z" stroke="white" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
            <path d="M16 7v13M7 12l9 5 9-5" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
          <span>The Trust Voice</span>
        </div>
        <button className="btn-ghost-sm" onClick={onSignOut}>Sign out</button>
      </header>

      <main className="selector-main">
        <h2 className="selector-heading">Select an estate</h2>
        <p className="selector-sub">Choose which estate you'd like to query today.</p>
        <div className="client-grid">
          {clients.map(client => (
            <button
              key={client.id}
              className="client-card"
              onClick={() => onSelect(client)}
            >
              <div className="client-card-icon">
                {client.name.charAt(0).toUpperCase()}
              </div>
              <div className="client-card-name">{client.name}</div>
              <div className="client-card-arrow">→</div>
            </button>
          ))}
        </div>
      </main>
    </div>
  );
}
