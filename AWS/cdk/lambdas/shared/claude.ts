import Anthropic from '@anthropic-ai/sdk';
import { getSecretJson } from './secrets';

interface AnthropicSecrets {
  api_key: string;
}

export interface ContextChunk {
  index: number;  // 1-based; matches [N] citations in the answer
  text: string;
  video_id: string;
  start_time: number;
  end_time: number;
  speaker: string;
}

export interface ClaudeResponse {
  answer: string;
  usedCitationIndices: number[];  // which [N] values appeared in the answer
}

// Cached per cold start
let anthropicClient: Anthropic | null = null;

// Exported so other shared modules (e.g. themeClassifier.ts) reuse the same
// cached client and secret-fetch logic instead of duplicating it.
export async function getClient(): Promise<Anthropic> {
  if (anthropicClient) return anthropicClient;
  const { api_key } = await getSecretJson<AnthropicSecrets>(
    process.env['ANTHROPIC_SECRET_ARN']!,
  );
  anthropicClient = new Anthropic({ apiKey: api_key });
  return anthropicClient;
}

const SYSTEM_PROMPT = `You are a trusted assistant helping a beneficiary understand the wishes \
of their loved one as recorded in video estate planning interviews conducted by The Trust Voice.

You have been provided numbered transcript excerpts from those recordings, labeled [1] through [N]. \
Each excerpt captures what was said at a specific moment in the video.

Rules you must follow:
- Answer only from the provided excerpts. Do not add information that is not present in the transcripts.
- Cite every excerpt you draw from using its number in square brackets — for example, [1] or [2][3].
- If the excerpts do not contain enough information to answer the question fully, say so directly \
  rather than speculating.
- Be warm, clear, and respectful. This is a sensitive context — the person being quoted is no \
  longer present, and the trustee is relying on these recordings to honor their wishes.
- Do not refer to yourself as an AI or mention the model or system you are running on.`;

function buildExcerptBlock(chunks: ContextChunk[]): string {
  return chunks
    .map(c => `[${c.index}] ${c.speaker ? `${c.speaker}: ` : ''}${c.text}`)
    .join('\n\n');
}

// Collects which citation indices Claude actually used in its answer, in
// first-appearance order. Callers return only those citations to the
// frontend — unused chunks are dropped.
function extractCitationIndices(answer: string): number[] {
  const usedCitationIndices: number[] = [];
  const citationRegex = /\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = citationRegex.exec(answer)) !== null) {
    const n = parseInt(match[1], 10);
    if (!usedCitationIndices.includes(n)) usedCitationIndices.push(n);
  }
  return usedCitationIndices;
}

export async function queryWithContext(
  question: string,
  chunks: ContextChunk[],
): Promise<ClaudeResponse> {
  const client = await getClient();

  const userMessage = `Transcript excerpts:\n\n${buildExcerptBlock(chunks)}\n\n---\n\nQuestion: ${question}`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const answer = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');

  return { answer, usedCitationIndices: extractCitationIndices(answer) };
}

// ── Principle-bridge fallback (Stage 2) — related-principle framing ─────────
//
// Only ever called from query/index.ts's runPrincipleBridge, itself only
// reachable when ENABLE_PRINCIPLE_BRIDGE=true and Stage 1 did not clear its
// confidence floor. Deliberately a separate function with its own system
// prompt rather than a mode flag on queryWithContext, so the existing
// direct-match path is provably untouched.
const RELATED_PRINCIPLE_SYSTEM_PROMPT = `You are a trusted assistant helping a beneficiary understand \
the wishes of their loved one as recorded in video estate planning interviews conducted by The Trust Voice.

You have been provided numbered transcript excerpts from those recordings, labeled [1] through [N]. \
The trustee's question was NOT directly addressed in the interviews. These excerpts are on a RELATED \
theme instead, not a direct answer — you must make that distinction unmistakable to the reader.

Your answer must follow this exact structure:
1. Say plainly that this specific situation was not addressed directly in the recordings.
2. Introduce the related theme in plain, warm language (not a technical label).
3. Share what was actually said on that related topic, citing every excerpt you draw from with its \
   number in square brackets — for example [1] or [2][3].
4. Close with a clear, explicit note that this may help the reader think it through, but it is not a \
   direct answer to what they asked.

Other rules you must still follow:
- Answer only from the provided excerpts. Do not add information that is not present in the transcripts.
- Never speculate or use language like "they would have wanted" about the specific situation asked about \
  — you are only reporting what was said on the related topic.
- Be warm, clear, and respectful. This is a sensitive context — the person being quoted is no longer \
  present, and the trustee is relying on these recordings to honor their wishes.
- Do not refer to yourself as an AI or mention the model or system you are running on.
- If, having read the excerpts, none of them are genuinely relevant enough to share even as related \
  context, say so plainly instead of forcing a connection — and do not cite anything in that case.`;

export async function queryRelatedPrinciple(
  question: string,
  chunks: ContextChunk[],
  themeLabels: string[],
): Promise<ClaudeResponse> {
  const client = await getClient();

  const themesLine = themeLabels.length > 0 ? themeLabels.join(', ') : '(unspecified)';
  const userMessage =
    `Related theme(s) these excerpts were retrieved for: ${themesLine}\n\n` +
    `Transcript excerpts:\n\n${buildExcerptBlock(chunks)}\n\n---\n\nQuestion: ${question}`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: RELATED_PRINCIPLE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const answer = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');

  return { answer, usedCitationIndices: extractCitationIndices(answer) };
}
