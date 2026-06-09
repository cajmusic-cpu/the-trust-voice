import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { withClientIsolation, type IsolationContext } from '../shared/withClientIsolation';
import { ok, badRequest, internalError } from '../shared/response';
import { embedText } from '../shared/embed';
import { searchChunks, fetchVectors, type ChunkMatch } from '../shared/pinecone';
import { queryWithContext } from '../shared/claude';
import { buildCitations } from '../shared/citations';
import { logQuery } from './log';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const CHUNKS_TABLE = process.env['CHUNKS_TABLE']!;

// Two chunks with embedding cosine similarity above this are considered the same
// topic; the lower-scoring one is dropped. 0.92 is intentionally strict — with
// large speaker-turn chunks (2–5 min) two different topics can score 0.85–0.90,
// so a loose threshold would discard legitimately distinct citations.
const COSINE_DEDUP_THRESHOLD = 0.92;

// Only extend a match with the following chunk when confidence meets this bar.
// Below it, returning a short concise clip is better than padding with adjacent
// content that may not be relevant to the question.
const EXTENSION_SCORE_THRESHOLD = 0.75;

// Clip overlap (in seconds) above which two citations from the same video are
// considered duplicates after extension. Extension grows end_time, so adjacent
// chunks returned by Pinecone can produce heavily overlapping clips.
const TIME_OVERLAP_SECONDS = 30;

// The first citation is always returned if any match exists. Additional
// citations are only included when their Pinecone score meets this bar —
// a low threshold produces thematically related but topically wrong results.
const SECOND_CITATION_THRESHOLD = 0.95;

// Hard cap on citations per query. Keeping this at 1 until a second interview
// is available — a single accurate citation is better than two where one is wrong.
const MAX_CITATIONS = 1;

// Adjacent chunk is only appended when its own embedding scores at or above
// this threshold against the query. Prevents irrelevant follow-on content
// (e.g. a topic change after a subject finishes answering) from being tacked on.
const ADJACENT_CHUNK_THRESHOLD = 0.70;

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

// Removes chunks whose embedding is more than COSINE_DEDUP_THRESHOLD similar to
// an already-kept chunk. Matches arrive score-descending, so the first occurrence
// of a near-duplicate topic is always the highest-scoring one.
function deduplicateMatches(matches: ChunkMatch[], threshold = COSINE_DEDUP_THRESHOLD): ChunkMatch[] {
  const kept: ChunkMatch[] = [];
  for (const match of matches) {
    const isDuplicate = match.values.length > 0 &&
      kept.some(k => k.values.length > 0 && cosineSimilarity(k.values, match.values) > threshold);
    if (!isDuplicate) kept.push(match);
  }
  return kept;
}

// Removes lower-scoring matches whose clip overlaps an already-kept match by
// more than TIME_OVERLAP_SECONDS on the same video. Run this after extension so
// the grown end_times are reflected in the overlap calculation. Matches are
// score-descending so the first occurrence of an overlapping region is kept.
function removeTimeOverlaps(matches: ChunkMatch[]): ChunkMatch[] {
  const kept: ChunkMatch[] = [];
  for (const match of matches) {
    const overlaps = kept.some(k => {
      if (k.metadata.video_id !== match.metadata.video_id) return false;
      const overlapStart = Math.max(k.metadata.start_time, match.metadata.start_time);
      const overlapEnd = Math.min(k.metadata.end_time, match.metadata.end_time);
      return overlapEnd - overlapStart > TIME_OVERLAP_SECONDS;
    });
    if (!overlaps) kept.push(match);
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

// Slices the displayed transcript text so it begins at the sentence matching
// startTime (as refined by bestSentenceTime). When bestSentenceTime moves startTime
// into the middle of a chunk, the earlier sentences are dropped from the quote.
// The extension suffix (text appended from the adjacent chunk) is preserved intact.
function trimTextToStartTime(sentencesJson: string | undefined, startTime: number, fullText: string): string {
  if (!sentencesJson) return fullText;
  let sentences: SentenceMarker[];
  try { sentences = JSON.parse(sentencesJson) as SentenceMarker[]; }
  catch { return fullText; }
  const idx = sentences.findIndex(s => s.startTime === startTime);
  if (idx <= 0) return fullText;
  const fromSentence = sentences.slice(idx).map(s => s.text).join(' ');
  const originalText = sentences.map(s => s.text).join(' ');
  if (fullText.length > originalText.length) {
    const extension = fullText.slice(originalText.length).trim();
    return extension ? `${fromSentence} ${extension}` : fromSentence;
  }
  return fromSentence;
}

// Fetches the chunk immediately after the given chunkIndex for the same video.
// Returns { end_time, text } if it exists, null if the matched chunk is the last one.
async function fetchNextChunk(
  clientId: string,
  videoId: string,
  chunkIndex: number,
): Promise<{ end_time: number; text: string } | null> {
  const sk = `VIDEO#${videoId}#CHUNK#${String(chunkIndex + 1).padStart(6, '0')}`;
  const res = await ddb.send(new GetCommand({
    TableName: CHUNKS_TABLE,
    Key: { client_id: clientId, sk },
    ProjectionExpression: 'end_time, #txt',
    ExpressionAttributeNames: { '#txt': 'text' },
  }));
  if (!res.Item) return null;
  return res.Item as { end_time: number; text: string };
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
    { clientId, userEmail }: IsolationContext,
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
      const matches = deduplicateMatches(
        await searchChunks(clientId, embedding, 3, { is_subject: true }),
      );

      if (matches.length === 0) {
        return ok({
          answer:
            "I don't have any relevant transcript excerpts to answer this question. " +
            "This topic may not have been covered in the recorded interviews.",
          citations: [],
        });
      }

      // Step 3: Extend each high-confidence match with the immediately following
      // chunk. Combined text lets Claude synthesize complete answers that span a
      // chunk boundary; combined endTime plays both as a single continuous clip.
      // Low-confidence matches (score < EXTENSION_SCORE_THRESHOLD) are returned
      // as-is — padding a weak match with adjacent content adds noise.
      const extendedMatches: ChunkMatch[] = await Promise.all(
        matches.map(async m => {
          if (m.score < EXTENSION_SCORE_THRESHOLD) return m;
          const nextId = `${m.metadata.video_id}/${m.metadata.chunk_index + 1}`;
          const [next, adjacentVectors] = await Promise.all([
            fetchNextChunk(clientId, m.metadata.video_id, m.metadata.chunk_index),
            fetchVectors(clientId, [nextId]),
          ]);
          if (!next) return m;
          const adjacentVec = adjacentVectors[nextId];
          const adjacentScore = adjacentVec ? cosineSimilarity(embedding, adjacentVec) : 0;
          if (adjacentScore < ADJACENT_CHUNK_THRESHOLD) return m;
          return {
            ...m,
            metadata: {
              ...m.metadata,
              end_time: next.end_time,
              text: `${m.metadata.text} ${next.text}`,
            },
          };
        }),
      );

      // Step 4: Remove clips that heavily overlap in time. Extension grows
      // end_time, so two adjacent chunks returned by Pinecone can produce clips
      // that overlap by hundreds of seconds — a second citation with >30 s of
      // shared video content adds no new information.
      const deduped = removeTimeOverlaps(extendedMatches);

      // Step 5: Apply per-citation score gate and hard cap.
      // The top match is always included. Any additional match must score at or
      // above SECOND_CITATION_THRESHOLD — below that the retrieval is surfacing
      // thematically similar but topically different content.
      const mergedMatches = deduped
        .filter((m, i) => i === 0 || m.score >= SECOND_CITATION_THRESHOLD)
        .slice(0, MAX_CITATIONS);

      // Step 6: Build context chunks for Claude (1-based index for citation matching)
      const contextChunks = mergedMatches.map((m, i) => ({
        index: i + 1,
        text: m.metadata.text,
        video_id: m.metadata.video_id,
        start_time: m.metadata.start_time,
        end_time: m.metadata.end_time,
        speaker: m.metadata.speaker,
      }));

      // Step 7: Ask Claude — it cites excerpts as [1], [2], etc.
      const { answer, usedCitationIndices } = await queryWithContext(question, contextChunks);

      // Step 8: Refine each match's startTime to the most question-relevant sentence
      // within the first chunk (sentences_json covers the Pinecone match only),
      // then map used citations back to structured objects.
      const refinedMatches = mergedMatches.map(m => {
        const newStartTime = bestSentenceTime(question, m.metadata.sentences_json, m.metadata.start_time);
        return {
          ...m,
          metadata: {
            ...m.metadata,
            start_time: newStartTime,
            text: trimTextToStartTime(m.metadata.sentences_json, newStartTime, m.metadata.text),
          },
        };
      });
      const citations = buildCitations(refinedMatches, usedCitationIndices);

      void logQuery({ clientId, userEmail, question, citationCount: citations.length })
        .catch(err => console.error('Failed to write query log:', err));

      return ok({ answer, citations });
    } catch (err) {
      console.error('Query pipeline failed:', err);
      return internalError();
    }
  },
);
