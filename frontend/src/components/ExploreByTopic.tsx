import { useState, useEffect, useMemo } from 'react';
import { getTopics, type TopicGroup } from '../api/client';
import { signOut } from '../auth/cognito';
import { AppHeader, type View } from './AppHeader';
import { CitationVideo, formatTime, formatSpeaker } from './QueryInterface';

interface Props {
  clientId: string;
  clientName: string;
  onSignOut: () => void;
  onBack?: () => void;
  onNavigate: (view: View) => void;
}

interface Section {
  name: string;
  themes: TopicGroup[];
}

// Groups the flat, taxonomy-ordered theme list into sections, preserving the
// order each section first appears in — themes.ts is already organized by
// section, but this doesn't assume contiguity.
function groupBySection(themes: TopicGroup[]): Section[] {
  const sections: Section[] = [];
  const bySectionName = new Map<string, Section>();
  for (const t of themes) {
    let section = bySectionName.get(t.section);
    if (!section) {
      section = { name: t.section, themes: [] };
      bySectionName.set(t.section, section);
      sections.push(section);
    }
    section.themes.push(t);
  }
  return sections;
}

export function ExploreByTopic({ clientId, clientName, onSignOut, onBack, onNavigate }: Props) {
  const [themes, setThemes] = useState<TopicGroup[] | null>(null);
  const [error, setError] = useState('');
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setThemes(null);
    setError('');
    getTopics(clientId)
      .then(groups => { if (!cancelled) setThemes(groups); })
      .catch(() => { if (!cancelled) setError('Something went wrong loading topics. Please try again.'); });
    return () => { cancelled = true; };
  }, [clientId]);

  const sections = useMemo(() => (themes ? groupBySection(themes) : []), [themes]);

  function toggle(key: string) {
    setOpenKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function handleSignOut() {
    void signOut();
    onSignOut();
  }

  return (
    <div className="query-page">
      <AppHeader clientName={clientName} view="explore" onNavigate={onNavigate} onSignOut={handleSignOut} onBack={onBack} />

      <div className="explore-page">
        {themes === null && !error && (
          <div className="explore-loading">
            <span className="citation-video-spinner" />
          </div>
        )}

        {error && <p className="inline-error">{error}</p>}

        {themes !== null && !error && (
          <>
            <div className="empty-state explore-intro">
              <p className="empty-title">Explore {clientName}'s values</p>
              <p className="empty-sub">
                Browse what was shared, organized by theme — no question needed.
                Each topic shows every relevant moment from the recorded interviews.
              </p>
            </div>

            {sections.map(section => (
              <div key={section.name} className="topic-section">
                <h2 className="topic-section-title">{section.name}</h2>
                {section.themes.map(theme => {
                  const open = openKeys.has(theme.key);
                  return (
                    <div key={theme.key} className="topic-row">
                      <button
                        type="button"
                        className="topic-row-trigger"
                        aria-expanded={open}
                        onClick={() => toggle(theme.key)}
                      >
                        <span className="topic-row-label">{theme.label}</span>
                        <span className="topic-row-count">{theme.count}</span>
                        <svg
                          className={`topics-chevron${open ? ' topics-chevron--open' : ''}`}
                          width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"
                        >
                          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                      <div className={`topic-row-panel-wrap${open ? ' topic-row-panel-wrap--open' : ''}`}>
                        <div className="topic-row-panel-inner">
                          {/* Rendered only while open — a client can have many tagged chunks
                              across many themes, and mounting every CitationVideo up front
                              would fire a presigned-URL fetch per citation on page load. */}
                          {open && (theme.count === 0 ? (
                            <p className="topic-row-empty">No answers on this topic yet.</p>
                          ) : (
                            <div className="citations">
                              {theme.items.map((item, i) => (
                                <div key={`${item.videoId}-${item.startTime}-${i}`} className="citation-card">
                                  <div className="citation-meta">
                                    <span className="citation-time">
                                      {formatTime(item.startTime)} – {formatTime(item.endTime)}
                                    </span>
                                    <span className="citation-speaker">
                                      {formatSpeaker(item.speaker)}
                                    </span>
                                  </div>
                                  <CitationVideo
                                    clientId={clientId}
                                    videoId={item.videoId}
                                    startTime={item.startTime}
                                    endTime={item.endTime}
                                  />
                                  <blockquote className="citation-quote">"{item.quote}"</blockquote>
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
