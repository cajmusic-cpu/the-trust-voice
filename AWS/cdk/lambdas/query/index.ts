import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { withClientIsolation, type IsolationContext } from '../shared/withClientIsolation';
import { ok, badRequest, internalError } from '../shared/response';
import { embedText } from '../shared/embed';
import { searchChunks, type ChunkMatch } from '../shared/pinecone';
import { queryWithContext } from '../shared/claude';
import { buildCitations } from '../shared/citations';

interface QueryBody {
  question: string;
}

interface SentenceMarker {
  startTime: number;
  text: string;
}

// Within a matched chunk, find the sentence whose words overlap most with the
// question. Falls back to the chunk startTime when sentences_json is absent
// (old vectors) or when no keyword overlap is found (first sentence = chunk start).
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// Removes chunks whose embedding is more than `threshold` similar to an
// already-kept chunk. Matches arrive score-descending, so the first occurrence
// of a near-duplicate topic is always the highest-scoring one.
function deduplicateMatches(matches: ChunkMatch[], threshold = 0.85): ChunkMatch[] {
  const kept: ChunkMatch[] = [];
  for (const match of matches) {
    const isDuplicate = match.values.length > 0 &&
      kept.some(k => k.values.length > 0 && cosineSimilarity(k.values, match.values) > threshold);
    if (!isDuplicate) kept.push(match);
  }
  return kept;
}

function bestSentenceTime(question: string, sentencesJson: string | undefined, fallback: number): number {
  if (!sentencesJson) return fallback;
  let sentences: SentenceMarker[];
  try {
    sentences = JSON.parse(sentencesJson) as SentenceMarker[];
  } catch {
    return fallback;
  }
  if (sentences.length <= 1) return fallback;

  const qWords = new Set(
    question.toLowerCase().split(/\W+/).filter(w => w.length > 3),
  );

  let best = sentences[0];
  let bestScore = 0;
  for (const s of sentences) {
    const score = s.text.toLowerCase().split(/\W+/).filter(w => qWords.has(w)).length;
    if (score > bestScore) { bestScore = score; best = s; }
  }

  return best.startTime;
}

function parseBody(event: APIGatewayProxyEvent): QueryBody | null {
  if (!event.body) return null;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf-8')
      : event.body;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'question' in parsed &&
      typeof (parsed as { question: unknown }).question === 'string'
    ) {
      return parsed as QueryBody;
    }
    return null;
  } catch {
    return null;
  }
}

export const handler = withClientIsolation(
  async (
    event: APIGatewayProxyEvent,
    { clientId }: IsolationContext,
  ): Promise<APIGatewayProxyResult> => {
    // clientId is guaranteed non-null here — withClientIsolation validated it
    // against the JWT, and this route always has a {clientId} path parameter.
    if (!clientId) return internalError();

    const body = parseBody(event);
    const question = body?.question.trim();
    if (!question) {
      return badRequest('question is required and must be a non-empty string');
    }

    try {
      const embedding = await embedText(question);

      // Step 2: Retrieve the most relevant transcript chunks from Pinecone.
      // The namespace equals clientId — data isolation is enforced at both
      // the JWT layer (withClientIsolation) and the vector DB layer (namespace).
      const matches = deduplicateMatches(await searchChunks(clientId, embedding, 3));

      if (matches.length === 0) {
        return ok({
          answer:
            "I don't have any relevant transcript excerpts to answer this question. " +
            "This topic may not have been covered in the recorded interviews.",
          citations: [],
        });
      }

      // Step 3: Build context chunks for Claude (1-based index for citation matching)
      const contextChunks = matches.map((m, i) => ({
        index: i + 1,
        text: m.metadata.text,
        video_id: m.metadata.video_id,
        start_time: m.metadata.start_time,
        end_time: m.metadata.end_time,
        speaker: m.metadata.speaker,
      }));

      // Step 4: Ask Claude — it cites excerpts as [1], [2], etc.
      const { answer, usedCitationIndices } = await queryWithContext(question, contextChunks);

      // Step 5: Refine each match's startTime to the most question-relevant sentence
      // within the chunk, then map used citations back to structured objects.
      const refinedMatches = matches.map(m => ({
        ...m,
        metadata: {
          ...m.metadata,
          start_time: bestSentenceTime(question, m.metadata.sentences_json, m.metadata.start_time),
        },
      }));
      const citations = buildCitations(refinedMatches, usedCitationIndices);

      return ok({ answer, citations });
    } catch (err) {
      console.error('Query pipeline failed:', err);
      return internalError();
    }
  },
);
