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
        <div className="top-bar-brand brand-wordmark">The <span>Trust</span> Voice</div>
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
