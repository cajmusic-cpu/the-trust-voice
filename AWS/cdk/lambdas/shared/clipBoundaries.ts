// Clip-boundary trimming — shared by query/index.ts (Stage 1/2, always with a
// query embedding) and topics/index.ts (the "Explore by Topic" browse view,
// always without one — there's no question to score against, just a chunk to
// show as-is). Relocated verbatim out of query/index.ts; no logic changed by
// the move. See speakerBoundaries's doc comment for the boundary-selection
// algorithm itself.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { embedTexts } from './embed';
import type { ChunkMatch } from './pinecone';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const VIDEOS_TABLE = process.env['VIDEOS_TABLE']!;

// Minimum silence gap (seconds) that signals a topic/answer boundary.
// A pause of this length between sentence[i].endTime and sentence[i+1].startTime
// closes the current citation clip regardless of speaker label changes.
const SILENCE_GAP_SECONDS = 2.5;

export interface SentenceMarker {
  startTime: number;
  endTime: number;   // endTime of last word — used for silence-gap boundary detection
  text: string;
  speaker: string;  // 'spk_0', 'spk_1', etc. — set by buildSentences at ingest time
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface SubjectBlock {
  startIdx: number;
  endIdx: number;    // exclusive
  startTime: number;
  endTime: number;
  text: string;
}

// Splits a chunk's sentences into runs of the subject speaker's own speech,
// using three signals in priority order:
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
//     speaker label accuracy. Block endTime records the actual endTime of the last
//     subject sentence so the clip cuts at the correct word boundary.
//
//  3. Speaker labels (secondary boundary): when no silence gap closes the block,
//     2+ consecutive non-subject sentences end it — retained as a fallback for
//     chunks indexed before endTimes were stored.
//
// A chunk with one uninterrupted subject answer yields one block; a chunk where an
// interviewer question splits two unrelated subject answers yields two (or more) —
// this is what a multi-topic chunk looks like structurally, and what
// shared/blockThemeClassifier.ts keys off to classify each answer on its own
// terms instead of blurring them into one whole-chunk classification. Returns []
// when sentencesJson is absent, malformed, empty, or lacks speaker labels.
export function findSubjectBlocks(sentencesJson: string | undefined, subjectSpeaker?: string): SubjectBlock[] {
  if (!sentencesJson) return [];

  let sentences: SentenceMarker[];
  try { sentences = JSON.parse(sentencesJson) as SentenceMarker[]; }
  catch { return []; }

  if (sentences.length === 0 || !sentences[0].speaker) return [];

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
  const fallbackEndTime = sentences[sentences.length - 1]!.endTime;

  interface RawBlock { startIdx: number; endIdx: number; endTimestamp: number }
  const rawBlocks: RawBlock[] = [];

  let blockStart: number | null = null;
  let lastSubjectEndTime = fallbackEndTime;
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
      rawBlocks.push({ startIdx: blockStart, endIdx: textEndIdx, endTimestamp: lastSubjectEndTime });
      blockStart = null;
      lastSubjectEndTime = fallbackEndTime;
      lastSubjectIdx = -1;
    }
  }

  if (blockStart !== null) {
    const textEndIdx = lastSubjectIdx >= blockStart ? lastSubjectIdx + 1 : sentences.length;
    rawBlocks.push({ startIdx: blockStart, endIdx: textEndIdx, endTimestamp: lastSubjectEndTime });
  }

  return rawBlocks.map(b => ({
    startIdx: b.startIdx,
    endIdx: b.endIdx,
    startTime: sentences[b.startIdx]!.startTime,
    endTime: b.endTimestamp,
    text: sentences.slice(b.startIdx, b.endIdx).map(s => s.text).join(' '),
  }));
}

// Picks one clip out of a chunk's subject blocks and returns its boundaries —
// the block whose text embeds closest to the query when one is given (same
// cosine metric Pinecone used to retrieve the chunk), otherwise the largest
// block (still deterministic, no AI judgment call — see findSubjectBlocks's
// doc comment for when that fallback applies). Falls back to the chunk's
// original boundaries when sentencesJson is absent or lacks speaker labels.
export async function speakerBoundaries(
  sentencesJson: string | undefined,
  originalStartTime: number,
  originalEndTime: number,
  fullText: string,
  queryEmbedding?: number[],
  subjectSpeaker?: string,
): Promise<{ startTime: number; endTime: number; text: string }> {
  const fallback = { startTime: originalStartTime, endTime: originalEndTime, text: fullText };

  const blocks = findSubjectBlocks(sentencesJson, subjectSpeaker);
  if (blocks.length === 0) return fallback;

  let best: SubjectBlock;
  if (blocks.length === 1 || !queryEmbedding) {
    best = blocks.reduce((a, b) => (b.endIdx - b.startIdx) > (a.endIdx - a.startIdx) ? b : a);
  } else {
    const blockEmbeddings = await embedTexts(blocks.map(b => b.text));
    let bestScore = -Infinity;
    let bestIdx = 0;
    for (let i = 0; i < blockEmbeddings.length; i++) {
      const score = cosineSimilarity(queryEmbedding, blockEmbeddings[i]!);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    best = blocks[bestIdx]!;
  }

  return { startTime: best.startTime, endTime: best.endTime, text: best.text };
}

// Reads subject_speaker from the video record — globally computed across the full
// interview, so it is reliable even on short chunks where local sentence count inverts.
export async function fetchSubjectSpeaker(clientId: string, videoId: string): Promise<string | undefined> {
  const res = await ddb.send(new GetCommand({
    TableName: VIDEOS_TABLE,
    Key: { client_id: clientId, video_id: videoId },
    ProjectionExpression: 'subject_speaker',
  }));
  return (res.Item as { subject_speaker?: string } | undefined)?.subject_speaker;
}

// Applies speaker/silence-gap clip trimming to an arbitrary set of matches.
// Shared by query/index.ts's Stage 1 and Stage 2 (always called with a query
// embedding, so a chunk with multiple subject blocks picks the one closest to
// the question) and by topics/index.ts's browse view (always called with
// embedding left undefined — no question to score against, so the largest
// subject block is used instead; see speakerBoundaries above).
export async function refineClipBoundaries(
  clientId: string,
  matches: ChunkMatch[],
  embedding?: number[],
): Promise<ChunkMatch[]> {
  const uniqueVideoIds = [...new Set(matches.map(m => m.metadata.video_id))];
  const speakerResults = await Promise.all(
    uniqueVideoIds.map(vid => fetchSubjectSpeaker(clientId, vid)),
  );
  const subjectSpeakerByVideo = new Map<string, string | undefined>(
    uniqueVideoIds.map((vid, i) => [vid, speakerResults[i]]),
  );

  return Promise.all(matches.map(async m => {
    const { startTime, endTime, text } = await speakerBoundaries(
      m.metadata.sentences_json,
      m.metadata.start_time,
      m.metadata.end_time,
      m.metadata.text,
      embedding,
      subjectSpeakerByVideo.get(m.metadata.video_id),
    );
    return { ...m, metadata: { ...m.metadata, start_time: startTime, end_time: endTime, text } };
  }));
}
