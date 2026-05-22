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

async function getClient(): Promise<Anthropic> {
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

export async function queryWithContext(
  question: string,
  chunks: ContextChunk[],
): Promise<ClaudeResponse> {
  const client = await getClient();

  const excerptBlock = chunks
    .map(c => `[${c.index}] ${c.speaker ? `${c.speaker}: ` : ''}${c.text}`)
    .join('\n\n');

  const userMessage = `Transcript excerpts:\n\n${excerptBlock}\n\n---\n\nQuestion: ${question}`;

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

  // Collect which citation indices Claude actually used in its answer.
  // We return only those citations to the frontend — unused chunks are dropped.
  const usedCitationIndices: number[] = [];
  const citationRegex = /\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = citationRegex.exec(answer)) !== null) {
    const n = parseInt(match[1], 10);
    if (!usedCitationIndices.includes(n)) usedCitationIndices.push(n);
  }

  return { answer, usedCitationIndices };
}
