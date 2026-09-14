// Principle-bridge fallback retrieval — theme classification.
//
// Bridges raw text (a transcript chunk at ingestion time, or a trustee's
// question at query time) to the fixed theme taxonomy in shared/themes.ts,
// via a constrained Claude call. Never invents a theme key that isn't in the
// table, and never throws — callers get [] on any failure (a bad/empty
// classification must not fail ingestion, and must not fail a live query).

import type Anthropic from '@anthropic-ai/sdk';
import { getClient } from './claude';
import { THEMES, themesPromptBlock, findTheme } from './themes';

const MAX_THEMES = 2;

const SYSTEM_PROMPT = `You classify text from an estate-planning interview against a fixed list of \
themes. You must choose ONLY from the theme keys listed below — never invent a new key, never \
alter a key's spelling. Return the ${MAX_THEMES} best-matching keys, most relevant first, as a \
JSON array of strings and nothing else (e.g. ["wealth_purpose"] or ["helping_vs_enabling", \
"financial_independence"]). If nothing in the list is a genuinely good match, return an empty \
array [] — do not force a weak match.

Themes:
${themesPromptBlock()}`;

function parseThemeKeys(raw: string): string[] {
  // Claude is asked for a bare JSON array; tolerate minor wrapping (code
  // fences, a leading/trailing sentence) by extracting the first [...] block.
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const valid: string[] = [];
  for (const item of parsed) {
    if (typeof item === 'string' && findTheme(item) && !valid.includes(item)) {
      valid.push(item);
    }
    if (valid.length >= MAX_THEMES) break;
  }
  return valid;
}

async function classify(text: string, label: string): Promise<string[]> {
  if (!text.trim()) return [];
  try {
    const client = await getClient();
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 128,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    });
    const raw = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');
    return parseThemeKeys(raw);
  } catch (err) {
    // Best-effort only — a classification failure must never break ingestion
    // or a live query. Log for visibility and move on with no themes.
    console.error(`Theme classification failed (${label}):`, err);
    return [];
  }
}

// Called once per is_subject chunk at ingestion time (process-transcript) and
// by the one-off backfill script. Themes assigned this way are never re-derived
// from a cached prior result — re-running against the current shared/themes.ts
// is always a full, fresh reconciliation.
export async function classifyChunkThemes(chunkText: string): Promise<string[]> {
  return classify(chunkText, 'chunk');
}

// Called by Stage 2 of query/index.ts (only when ENABLE_PRINCIPLE_BRIDGE=true)
// to pick 1–2 themes for the trustee's actual question.
export async function classifyQuestionThemes(question: string): Promise<string[]> {
  return classify(question, 'question');
}

// Exposed for tests / tooling that want to confirm the taxonomy loaded.
export const THEME_COUNT = THEMES.length;
