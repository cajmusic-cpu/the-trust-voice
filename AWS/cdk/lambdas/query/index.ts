import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { withClientIsolation, type IsolationContext } from '../shared/withClientIsolation';
import { ok, badRequest, internalError } from '../shared/response';
import { embedText, embedTexts } from '../shared/embed';
import { searchChunks, type ChunkMatch } from '../shared/pinecone';
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

// Adjacent chunk is only appended when its opening sentences embed at or above
// this threshold against the query. Scoring only the opening segment (not the
// full chunk) avoids dilution from unrelated content later in a multi-topic chunk —
// a chunk whose first half continues the answer but second half shifts topic will
// score low on the full-chunk vector but high on the opening-segment vector.
const ADJACENT_CHUNK_THRESHOLD = 0.70;

// Number of sentences to extract from the adjacent chunk when scoring its relevance.
// Five sentences captures enough context to judge whether the chunk opens on the
// same topic without being pulled off-target by later content.
const ADJACENT_SENTENCE_COUNT = 5;

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

  // 5+ char words only: eliminates common 4-char noise words ("that", "with",
  // "what") that appear in nearly every sentence and inflate scores artificially.
  const qWords = new Set(
    question.toLowerCase().split(/\W+/).filter(w => w.length > 4),
  );

  // Count distinct qWords present in each sentence (Set intersection), not total
  // occurrences. A word repeated twice in a sentence is one keyword match, not two.
  // Skip interviewer question sentences (ending '?') — they contain the same keywords
  // as the query but point to the wrong speaker and wrong temporal region.
  // Require 2+ distinct keyword matches (bestScore starts at 1) before overriding
  // the fallback — a single-keyword match is unreliable as a position signal.
  let best: SentenceMarker | null = null;
  let bestScore = 1;
  for (const s of sentences) {
    if (s.text.trimEnd().endsWith('?')) continue;
    const sentenceWords = new Set(s.text.toLowerCase().split(/\W+/));
    const score = [...qWords].filter(w => sentenceWords.has(w)).length;
    if (score > bestScore) { bestScore = score; best = s; }
  }

  return best !== null ? best.startTime : fallback;
}

// Trims the displayed text and video boundaries to the relevant answer window.
//
// Start: drops sentences before startTime (as refined by bestSentenceTime).
// End: scans forward from the start sentence and truncates at the first interviewer
// question (sentence ending '?') found after it. A question mid-chunk marks a topic
// shift; content from there on belongs to a different answer. The extension suffix
// (text appended from an adjacent chunk at query time) is preserved only when no
// intra-chunk topic break is found — if a question was found the natural endpoint is
// already within the chunk and there is no reason to play into the adjacent content.
//
// Returns { text, endTime } — endTime may be shorter than originalEndTime when a
// topic-break question is detected within sentences_json.
function trimCitationBoundaries(
  sentencesJson: string | undefined,
  startTime: number,
  originalEndTime: number,
  fullText: string,
): { text: string; endTime: number } {
  if (!sentencesJson) return { text: fullText, endTime: originalEndTime };
  let sentences: SentenceMarker[];
  try { sentences = JSON.parse(sentencesJson) as SentenceMarker[]; }
  catch { return { text: fullText, endTime: originalEndTime }; }

  // idx === -1 (not found) or idx === 0 (chunk start) both map to fromIdx = 0.
  const idx = sentences.findIndex(s => s.startTime === startTime);
  const fromIdx = idx <= 0 ? 0 : idx;

  // Search for the first pair of consecutive '?' sentences after the start sentence.
  // Two consecutive questions reliably signals an interviewer turn (main question +
  // follow-up); a single isolated '?' is typically a rhetorical device in the
  // subject's own speech and should not trigger truncation.
  // Starting at fromIdx + 1 ensures the very first sentence never truncates the clip.
  let questionIdx = -1;
  for (let i = fromIdx + 1; i < sentences.length - 1; i++) {
    if (
      sentences[i].text.trimEnd().endsWith('?') &&
      sentences[i + 1].text.trimEnd().endsWith('?')
    ) {
      questionIdx = i;
      break;
    }
  }

  const toIdx = questionIdx !== -1 ? questionIdx : sentences.length;
  const newEndTime = questionIdx !== -1 ? sentences[questionIdx].startTime : originalEndTime;
  const trimmedText = sentences.slice(fromIdx, toIdx).map(s => s.text).join(' ');

  if (questionIdx === -1) {
    const originalText = sentences.map(s => s.text).join(' ');
    if (fullText.length > originalText.length) {
      const extension = fullText.slice(originalText.length).trim();
      return { text: extension ? `${trimmedText} ${extension}` : trimmedText, endTime: newEndTime };
    }
  }

  return { text: trimmedText, endTime: newEndTime };
}

// Fetches the chunk immediately after the given chunkIndex for the same video.
// Returns { end_time, text, sentences_json } if it exists, null if the matched
// chunk is the last one. sentences_json is used to score the opening segment and
// to merge sentence boundaries when extension fires.
async function fetchNextChunk(
  clientId: string,
  videoId: string,
  chunkIndex: number,
): Promise<{ end_time: number; text: string; sentences_json?: string } | null> {
  const sk = `VIDEO#${videoId}#CHUNK#${String(chunkIndex + 1).padStart(6, '0')}`;
  const res = await ddb.send(new GetCommand({
    TableName: CHUNKS_TABLE,
    Key: { client_id: clientId, sk },
    ProjectionExpression: 'end_time, #txt, sentences_json',
    ExpressionAttributeNames: { '#txt': 'text' },
  }));
  if (!res.Item) return null;
  return res.Item as { end_time: number; text: string; sentences_json?: string };
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

      // Step 3: Extend each match with the immediately following chunk when its
      // opening sentences are topically continuous with the query.
      //
      // Scoring only the first ADJACENT_SENTENCE_COUNT sentences (not the full
      // stored vector) prevents dilution when an adjacent chunk spans multiple
      // topics — a chunk whose first half continues the answer but second half
      // shifts topic scores low on its full vector but high on its opening segment.
      //
      // When extension fires, both chunks' sentences_json arrays are merged so
      // trimCitationBoundaries can detect topic-break questions anywhere across
      // the combined clip and stop the video before unrelated content begins.

      // Phase A: fetch all adjacent chunks in parallel.
      const nextChunks = await Promise.all(
        matches.map(m => fetchNextChunk(clientId, m.metadata.video_id, m.metadata.chunk_index)),
      );

      // Phase B: extract first-N-sentence segment text from each adjacent chunk.
      const adjacentSegments = nextChunks.map(next => {
        if (!next?.sentences_json) return null;
        try {
          const sents = JSON.parse(next.sentences_json) as SentenceMarker[];
          const text = sents.slice(0, ADJACENT_SENTENCE_COUNT).map(s => s.text).join(' ');
          return text || null;
        } catch {
          return null;
        }
      });

      // Phase C: batch-embed all non-null segments (one Bedrock call sequence).
      const toEmbedIdxs: number[] = [];
      const toEmbedTexts: string[] = [];
      adjacentSegments.forEach((seg, i) => {
        if (seg) { toEmbedIdxs.push(i); toEmbedTexts.push(seg); }
      });
      const segEmbeddings = toEmbedTexts.length > 0 ? await embedTexts(toEmbedTexts) : [];
      const adjacentEmbedMap = new Map<number, number[]>();
      toEmbedIdxs.forEach((idx, pos) => adjacentEmbedMap.set(idx, segEmbeddings[pos]));

      // Phase D: score each opening segment and extend when threshold met.
      const extendedMatches: ChunkMatch[] = matches.map((m, i) => {
        const next = nextChunks[i];
        if (!next) return m;
        const adjVec = adjacentEmbedMap.get(i);
        const adjacentScore = adjVec ? cosineSimilarity(embedding, adjVec) : 0;
        if (adjacentScore < ADJACENT_CHUNK_THRESHOLD) return m;

        // Merge sentences_json so trimCitationBoundaries can find topic-break
        // questions in the adjacent chunk and clip the video there.
        let mergedSentencesJson = m.metadata.sentences_json;
        if (m.metadata.sentences_json && next.sentences_json) {
          try {
            const a = JSON.parse(m.metadata.sentences_json) as SentenceMarker[];
            const b = JSON.parse(next.sentences_json) as SentenceMarker[];
            mergedSentencesJson = JSON.stringify([...a, ...b]);
          } catch { /* keep primary sentences_json */ }
        }

        return {
          ...m,
          metadata: {
            ...m.metadata,
            end_time: next.end_time,
            text: `${m.metadata.text} ${next.text}`,
            sentences_json: mergedSentencesJson,
          },
        };
      });

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

      // Step 8: Refine each match's start/end boundaries using sentence-level data.
      // bestSentenceTime finds the most query-relevant sentence within the chunk for
      // the startTime. trimCitationBoundaries handles both ends: it trims leading
      // sentences before startTime and truncates at the first topic-break question
      // ('?' sentence) found after startTime, tightening the endTime so the video
      // clip stops before the interviewer shifts to an unrelated topic.
      const refinedMatches = mergedMatches.map(m => {
        const newStartTime = bestSentenceTime(question, m.metadata.sentences_json, m.metadata.start_time);
        const { text, endTime } = trimCitationBoundaries(
          m.metadata.sentences_json,
          newStartTime,
          m.metadata.end_time,
          m.metadata.text,
        );
        return {
          ...m,
          metadata: {
            ...m.metadata,
            start_time: newStartTime,
            end_time: endTime,
            text,
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
