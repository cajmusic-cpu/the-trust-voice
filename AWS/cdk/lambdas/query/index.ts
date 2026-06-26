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
const VIDEOS_TABLE = process.env['VIDEOS_TABLE']!;

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

// Minimum silence gap (seconds) that signals a topic/answer boundary.
// A pause of this length between sentence[i].endTime and sentence[i+1].startTime
// closes the current citation clip regardless of speaker label changes.
const SILENCE_GAP_SECONDS = 2.5;

interface SentenceMarker {
  startTime: number;
  endTime: number;   // endTime of last word — used for silence-gap boundary detection
  text: string;
  speaker: string;  // 'spk_0', 'spk_1', etc. — set by buildSentences at ingest time
}

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

// Determines clip start and end boundaries using three signals in priority order:
//
//  1. Subject speaker (Change 3): taken from the globally-computed subject_speaker
//     on the video record (word counts across the entire interview). Falls back to
//     local majority-sentence count only when no global value is passed — the
//     local count can invert on short chunks where the interviewer has more
//     sentences than the subject.
//
//  2. Silence gap (Change 2, primary boundary): a gap ≥ SILENCE_GAP_SECONDS between
//     sentence[i].endTime and sentence[i+1].startTime closes the current block.
//     Multi-second pauses are a reliable interview structure signal independent of
//     speaker label accuracy. endTimestamp records the actual endTime of the last
//     subject sentence so the clip cuts at the correct word boundary.
//
//  3. Speaker labels (secondary boundary): when no silence gap closes the block,
//     2+ consecutive non-subject sentences end it — retained as a fallback for
//     chunks indexed before endTimes were stored.
//
//  When multiple subject blocks exist in a chunk, the block whose text embeds
//  closest to the query is selected (same cosine metric Pinecone used to retrieve
//  the chunk). Falls back to original boundaries when sentences_json is absent or
//  lacks speaker labels.
async function speakerBoundaries(
  sentencesJson: string | undefined,
  originalStartTime: number,
  originalEndTime: number,
  fullText: string,
  queryEmbedding?: number[],
  subjectSpeaker?: string,
): Promise<{ startTime: number; endTime: number; text: string }> {
  const fallback = { startTime: originalStartTime, endTime: originalEndTime, text: fullText };
  if (!sentencesJson) return fallback;

  let sentences: SentenceMarker[];
  try { sentences = JSON.parse(sentencesJson) as SentenceMarker[]; }
  catch { return fallback; }

  if (sentences.length === 0 || !sentences[0].speaker) return fallback;

  // Use globally-computed subject speaker when provided (Change 3).
  // Local majority-sentence count is kept as a fallback for vectors indexed
  // before the global value was stored on the video record.
  let resolvedSubjectSpeaker: string;
  if (subjectSpeaker) {
    resolvedSubjectSpeaker = subjectSpeaker;
  } else {
    const counts: Record<string, number> = {};
    for (const s of sentences) counts[s.speaker] = (counts[s.speaker] ?? 0) + 1;
    resolvedSubjectSpeaker = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![0];
  }

  // Silence-gap detection requires endTimes stored by Change 1.
  const hasEndTimes = sentences.some(s => typeof s.endTime === 'number' && s.endTime > 0);

  interface Block { startIdx: number; endIdx: number; endTimestamp: number }
  const blocks: Block[] = [];

  let blockStart: number | null = null;
  let lastSubjectEndTime = originalEndTime;
  let lastSubjectIdx = -1;

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const hasNext = i + 1 < sentences.length;

    // Open a new block at the first subject sentence.
    if (s.speaker === resolvedSubjectSpeaker && blockStart === null) {
      blockStart = i;
    }

    if (blockStart === null) continue;

    // Track the most-recent subject sentence position and endTime.
    if (s.speaker === resolvedSubjectSpeaker) {
      lastSubjectEndTime = (hasEndTimes && s.endTime > 0) ? s.endTime : s.startTime + 3;
      lastSubjectIdx = i;
    }

    let closeBlock = false;

    // PRIMARY: silence gap closes the block at the actual word boundary.
    if (hasEndTimes && hasNext && s.endTime > 0) {
      if (sentences[i + 1].startTime - s.endTime >= SILENCE_GAP_SECONDS) closeBlock = true;
    }

    // SECONDARY: 2+ consecutive non-subject sentences (fallback when no endTimes).
    if (!closeBlock && s.speaker !== resolvedSubjectSpeaker) {
      if (hasNext && sentences[i + 1].speaker !== resolvedSubjectSpeaker) closeBlock = true;
    }

    if (closeBlock) {
      // For text: only include through the last subject sentence so any non-subject
      // content at the boundary is excluded from the clip text.
      const textEndIdx = lastSubjectIdx >= blockStart ? lastSubjectIdx + 1 : i + 1;
      blocks.push({ startIdx: blockStart, endIdx: textEndIdx, endTimestamp: lastSubjectEndTime });
      blockStart = null;
      lastSubjectEndTime = originalEndTime;
      lastSubjectIdx = -1;
    }
  }

  if (blockStart !== null) {
    const textEndIdx = lastSubjectIdx >= blockStart ? lastSubjectIdx + 1 : sentences.length;
    blocks.push({ startIdx: blockStart, endIdx: textEndIdx, endTimestamp: lastSubjectEndTime });
  }

  if (blocks.length === 0) return fallback;

  let best: Block;
  if (blocks.length === 1 || !queryEmbedding) {
    best = blocks.reduce((a, b) => (b.endIdx - b.startIdx) > (a.endIdx - a.startIdx) ? b : a);
  } else {
    const blockTexts = blocks.map(b =>
      sentences.slice(b.startIdx, b.endIdx).map(s => s.text).join(' '),
    );
    const blockEmbeddings = await embedTexts(blockTexts);
    let bestScore = -Infinity;
    let bestIdx = 0;
    for (let i = 0; i < blockEmbeddings.length; i++) {
      const score = cosineSimilarity(queryEmbedding, blockEmbeddings[i]!);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    best = blocks[bestIdx]!;
  }

  const newStartTime = sentences[best.startIdx].startTime;
  const newEndTime = best.endTimestamp;
  const text = sentences.slice(best.startIdx, best.endIdx).map(s => s.text).join(' ');

  return { startTime: newStartTime, endTime: newEndTime, text };
}

// Reads subject_speaker from the video record — globally computed across the full
// interview, so it is reliable even on short chunks where local sentence count inverts.
async function fetchSubjectSpeaker(clientId: string, videoId: string): Promise<string | undefined> {
  const res = await ddb.send(new GetCommand({
    TableName: VIDEOS_TABLE,
    Key: { client_id: clientId, video_id: videoId },
    ProjectionExpression: 'subject_speaker',
  }));
  return (res.Item as { subject_speaker?: string } | undefined)?.subject_speaker;
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
      // speakerBoundaries can detect topic shifts anywhere across the combined clip
      // and stop the video before unrelated content begins.

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

        // Merge sentences_json so speakerBoundaries can find the topic-shift
        // run anywhere across the combined clip and stop the video there.
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

      // Step 8: Set clip boundaries using silence gaps, global subject speaker, and
      // speaker labels. Fetch subject_speaker from the video record once per unique
      // video — it is computed globally across the full interview by process-transcript
      // and is reliable even on short chunks where local sentence count inverts.
      const uniqueVideoIds = [...new Set(mergedMatches.map(m => m.metadata.video_id))];
      const speakerResults = await Promise.all(
        uniqueVideoIds.map(vid => fetchSubjectSpeaker(clientId, vid)),
      );
      const subjectSpeakerByVideo = new Map<string, string | undefined>(
        uniqueVideoIds.map((vid, i) => [vid, speakerResults[i]]),
      );

      const refinedMatches = await Promise.all(mergedMatches.map(async m => {
        const { startTime, endTime, text } = await speakerBoundaries(
          m.metadata.sentences_json,
          m.metadata.start_time,
          m.metadata.end_time,
          m.metadata.text,
          embedding,
          subjectSpeakerByVideo.get(m.metadata.video_id),
        );
        return {
          ...m,
          metadata: {
            ...m.metadata,
            start_time: startTime,
            end_time: endTime,
            text,
          },
        };
      }));
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
