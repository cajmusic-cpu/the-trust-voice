import { useState, useRef, useEffect, type FormEvent, type KeyboardEvent } from 'react';
import { queryClient, getVideoUrl, type Citation } from '../api/client';
import { signOut } from '../auth/cognito';

const TOPICS = [
  "The grantor's values and what mattered most to them",
  "Guidance on supporting a beneficiary's education",
  "Helping a beneficiary purchase a home",
  "How to handle a beneficiary facing financial hardship",
  "The grantor's wishes around health, addiction, or treatment",
  "Supporting a beneficiary who wants to start a business",
  "Balancing fairness between different beneficiaries",
  "When to provide support and when to hold back",
  "The grantor's hopes for future generations",
  "How the grantor would want difficult or unexpected decisions handled",
];

interface Turn {
  question: string;
  answer: string;
  citations: Citation[];
}

// Cache presigned URLs for the session to avoid redundant fetches.
// Key: "{clientId}/{videoId}", Value: url string
const videoUrlCache = new Map<string, string>();

interface Props {
  clientId: string;
  clientName: string;
  onSignOut: () => void;
  onBack?: () => void;
}

export function QueryInterface({ clientId, clientName, onSignOut, onBack }: Props) {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [topicsOpen, setTopicsOpen] = useState(false);
  const conversationRef = useRef<HTMLDivElement>(null);
  const latestAnswerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (loading || turns.length === 0) return;
    const container = conversationRef.current;
    const answer = latestAnswerRef.current;

    // ── SCROLL DEBUG (temporary) ──────────────────────────────────────────────
    console.log('[ScrollDebug] refs:', {
      container: container ? container.className : 'NULL',
      answer: answer ? answer.className : 'NULL',
    });
    if (!container || !answer) {
      console.log('[ScrollDebug] Aborting — null ref');
      return;
    }
    const answerRect = answer.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const delta = answerRect.top - containerRect.top;
    const scrollTopBefore = container.scrollTop;
    const targetScrollTop = scrollTopBefore + delta;
    const anchorStyle = getComputedStyle(container).overflowAnchor;

    console.log('[ScrollDebug] Before scrollTo:', {
      'answer.getBoundingClientRect().top': answerRect.top,
      'container.getBoundingClientRect().top': containerRect.top,
      delta,
      scrollTopBefore,
      targetScrollTop,
      'container overflow-anchor (CSS)': anchorStyle,
    });

    container.scrollTo({ top: targetScrollTop, behavior: 'smooth' });

    // Sample scroll position at 400 ms intervals to catch both the smooth-scroll
    // landing point and any post-settle drift (scroll anchoring, etc.).
    [200, 400, 600, 900, 1200, 2000].forEach(ms => {
      setTimeout(() => {
        console.log(`[ScrollDebug] scrollTop at +${ms}ms:`, container.scrollTop,
          `(expected ${targetScrollTop}, drift ${container.scrollTop - targetScrollTop})`);
      }, ms);
    });
    // ── END SCROLL DEBUG ──────────────────────────────────────────────────────
  }, [turns, loading]);

  async function handleSubmit(e?: FormEvent) {
    e?.preventDefault();
    const q = question.trim();
    if (!q || loading) return;
    setQuestion('');
    setError('');
    setLoading(true);
    try {
      const res = await queryClient(clientId, q);
      setTurns(prev => [...prev, { question: q, answer: res.answer, citations: res.citations }]);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
      textareaRef.current?.focus();
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  function handleSignOut() {
    signOut();
    onSignOut();
  }

  return (
    <div className="query-page">
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
        </div>
        <div className="top-bar-right">
          <span className="client-badge">{clientName}</span>
          <button className="btn-ghost-sm" onClick={handleSignOut}>Sign out</button>
        </div>
      </header>

      <div className="conversation" ref={conversationRef}>
        {turns.length === 0 && !loading && (
          <div className="empty-state">
            <p className="empty-title">Ask about {clientName}'s wishes</p>
            <p className="empty-sub">
              Ask anything. Every answer is drawn from the grantor's recorded
              interviews and cited by timestamp.
            </p>
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i} className="turn">
            <div className="turn-question">
              <span className="turn-label">You</span>
              <p>{turn.question}</p>
            </div>
            <div className="turn-answer" ref={i === turns.length - 1 ? latestAnswerRef : null}>
              <span className="turn-label">Trust Voice</span>
              <div className="answer-text">
                {renderAnswer(turn.answer, turn.citations)}
              </div>
              {turn.citations.length > 0 && (
                <div className="citations">
                  <p className="citations-heading">Sources</p>
                  {turn.citations.map(c => (
                    <div key={c.index} id={`citation-${i}-${c.index}`} className="citation-card">
                      <div className="citation-meta">
                        <span className="citation-index">[{c.index}]</span>
                        <span className="citation-time">
                          {formatTime(c.startTime)} – {formatTime(c.endTime)}
                        </span>
                        <span className="citation-speaker">
                          {formatSpeaker(c.speaker)}
                        </span>
                      </div>
                      <CitationVideo clientId={clientId} videoId={c.videoId} startTime={c.startTime} endTime={c.endTime} />
                      <blockquote className="citation-quote">"{c.quote}"</blockquote>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="turn">
            <div className="turn-answer">
              <span className="turn-label">Trust Voice</span>
              <div className="thinking">
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        )}

        {error && <p className="inline-error">{error}</p>}
      </div>

      <div className="input-bar">
        <div className="topics-hint" style={{ maxWidth: 780, margin: '0 auto 12px' }}>
          <button
            className="topics-trigger"
            onClick={() => setTopicsOpen(o => !o)}
            aria-expanded={topicsOpen}
            type="button"
          >
            <span>Not sure where to start? Topics you can explore</span>
            <svg
              className={`topics-chevron${topicsOpen ? ' topics-chevron--open' : ''}`}
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className={`topics-panel-wrap${topicsOpen ? ' topics-panel-wrap--open' : ''}`}>
            <div className="topics-panel-inner">
              <div className="topics-panel">
                <p className="topics-intro">
                  Ask in your own words — the tool understands natural, conversational questions.
                  These are areas to explore, not exact phrases to use.
                </p>
                <ul className="topics-list">
                  {TOPICS.map((topic, i) => (
                    <li key={i} className="topics-item">{topic}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
        <form onSubmit={handleSubmit} className="input-form">
          <textarea
            ref={textareaRef}
            className="question-input"
            placeholder={`Ask about ${clientName}'s wishes…`}
            value={question}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={loading}
          />
          <button
            type="submit"
            className="send-btn"
            disabled={!question.trim() || loading}
            aria-label="Send"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M22 2L11 13M22 2L15 22 11 13 2 9l20-7z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            </svg>
          </button>
        </form>
        <p className="input-hint">Press Enter to send · Shift+Enter for new line</p>
      </div>
    </div>
  );
}

function renderAnswer(text: string, citations: Citation[]) {
  const parts = text.split(/(\[\d+\])/g);
  return parts.map((part, i) => {
    const match = /^\[(\d+)\]$/.exec(part);
    if (match) {
      const num = parseInt(match[1]);
      const exists = citations.some(c => c.index === num);
      if (exists) {
        return (
          <sup key={i} className="citation-ref">[{num}]</sup>
        );
      }
    }
    // Preserve line breaks as paragraph breaks
    return part.split('\n\n').map((para, j) => (
      <span key={`${i}-${j}`}>
        {j > 0 && <><br /><br /></>}
        {para}
      </span>
    ));
  });
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatSpeaker(label: string): string {
  // spk_0 → Grantor, spk_1 → Interviewer, etc.
  if (label === 'spk_0') return 'Grantor';
  if (label === 'spk_1') return 'Interviewer';
  const n = parseInt(label.replace(/\D/g, ''));
  return isNaN(n) ? label : `Speaker ${n + 1}`;
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

function CitationVideo({ clientId, videoId, startTime, endTime }: {
  clientId: string; videoId: string; startTime: number; endTime: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Stable ref so the timeupdate closure always reads the current endTime
  // without needing to re-register the listener on every render.
  const endTimeRef = useRef(endTime);
  useEffect(() => { endTimeRef.current = endTime; }, [endTime]);

  useEffect(() => {
    const cacheKey = `${clientId}/${videoId}`;
    const cached = videoUrlCache.get(cacheKey);
    if (cached) {
      setUrl(cached);
    } else {
      getVideoUrl(clientId, videoId)
        .then(u => { videoUrlCache.set(cacheKey, u); setUrl(u); })
        .catch(() => setLoadError(true));
    }
  }, [clientId, videoId]);

  function handleLoadedMetadata() {
    if (videoRef.current) videoRef.current.currentTime = startTime;
  }

  function handleSeeked() {
    if (!ready) setReady(true);
  }

  function handleCanPlay() {
    const video = videoRef.current;
    // Only accept canplay as a readiness signal when the browser is at startTime.
    // With preload="metadata", canplay can fire at position 0 before the seek to
    // startTime completes — accepting it there would expose the wrong frame.
    if (!ready && video && Math.abs(video.currentTime - startTime) < 1) {
      setReady(true);
    }
  }

  function handleTimeUpdate() {
    const video = videoRef.current;
    const end = endTimeRef.current;
    if (!video) return;
    if (video.currentTime >= end) {
      video.pause();
    }
  }

  // Native DOM timeupdate listener as backup — media events occasionally miss
  // React's synthetic dispatch during buffering transitions.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const stop = () => {
      const vid = videoRef.current;
      const end = endTimeRef.current;
      if (vid && vid.currentTime >= end) vid.pause();
    };
    video.addEventListener('timeupdate', stop);
    return () => video.removeEventListener('timeupdate', stop);
  }, [url]);

  function handlePlayClick() {
    const video = videoRef.current;
    if (!video) return;
    // If the clip ended, restart from startTime before playing again
    if (video.currentTime >= endTimeRef.current) {
      video.currentTime = startTime;
    }
    void video.play().catch(() => {});
  }

  if (loadError) return null;

  return (
    <div className="citation-video-wrap">
      {(!url || !ready) && (
        <div className="citation-video-loading">
          <span className="citation-video-spinner" />
        </div>
      )}
      {url && (
        <>
          <video
            ref={videoRef}
            className={`citation-video${ready ? ' citation-video--ready' : ''}`}
            src={`${url}#t=${Math.floor(startTime)}`}
            preload="metadata"
            playsInline
            onLoadedMetadata={handleLoadedMetadata}
            onSeeked={handleSeeked}
            onCanPlay={handleCanPlay}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={handleTimeUpdate}
            controls={playing}
          />
          {ready && (
            <div className="citation-clip-badge">
              {formatTime(startTime)}–{formatTime(endTime)} · {formatDuration(endTime - startTime)} clip
            </div>
          )}
          {ready && !playing && (
            <button
              className="citation-play-overlay citation-play-overlay--ready"
              onClick={handlePlayClick}
              aria-label="Play clip"
            >
              <svg className="citation-play-icon" viewBox="0 0 80 80" fill="none">
                <circle cx="40" cy="40" r="40" fill="rgba(15,30,46,0.6)" />
                <path d="M32 26l24 14-24 14V26z" fill="white" />
              </svg>
            </button>
          )}
        </>
      )}
    </div>
  );
}
