import { useState, useRef, useEffect, type FormEvent, type KeyboardEvent } from 'react';
import { queryClient, getVideoUrl, type Citation } from '../api/client';
import { signOut } from '../auth/cognito';

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
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
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

  async function openVideoAtTime(videoId: string, startTime: number) {
    const cacheKey = `${clientId}/${videoId}`;
    let url = videoUrlCache.get(cacheKey);
    if (!url) {
      url = await getVideoUrl(clientId, videoId);
      videoUrlCache.set(cacheKey, url);
    }
    // #t=N tells the browser's native video player to seek to that second
    window.open(`${url}#t=${Math.floor(startTime)}`, '_blank', 'noopener');
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
              <rect width="32" height="32" rx="8" fill="#1e3a5f" />
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

      <div className="conversation">
        {turns.length === 0 && !loading && (
          <div className="empty-state">
            <p className="empty-title">Ask about {clientName}'s wishes</p>
            <p className="empty-sub">
              Questions about property, investments, charitable giving, family
              instructions — anything covered in the recorded interviews.
            </p>
            <div className="example-questions">
              {[
                'What were the wishes about the family home?',
                'How should the investment accounts be divided?',
                'Were there instructions about charitable giving?',
              ].map(ex => (
                <button
                  key={ex}
                  className="example-btn"
                  onClick={() => { setQuestion(ex); textareaRef.current?.focus(); }}
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i} className="turn">
            <div className="turn-question">
              <span className="turn-label">You</span>
              <p>{turn.question}</p>
            </div>
            <div className="turn-answer">
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
                        <button
                          className="citation-watch-btn"
                          onClick={() => void openVideoAtTime(c.videoId, c.startTime)}
                          title={`Watch at ${formatTime(c.startTime)}`}
                        >
                          ▶ Watch
                        </button>
                      </div>
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
        <div ref={bottomRef} />
      </div>

      <div className="input-bar">
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
