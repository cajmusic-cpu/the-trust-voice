import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { withClientIsolation, type IsolationContext } from '../shared/withClientIsolation';
import { ok, badRequest, internalError } from '../shared/response';
import { embedText, embedTexts } from '../shared/embed';
import { searchChunks, type ChunkMatch } from '../shared/pinecone';
import { queryWithContext, queryRelatedPrinciple } from '../shared/claude';
import { buildCitations, type Citation } from '../shared/citations';
import { classifyQuestionThemes } from '../shared/themeClassifier';
import { findTheme } from '../shared/themes';
import { cosineSimilarity, refineClipBoundaries, type SentenceMarker } from '../shared/clipBoundaries';
import { logQuery } from './log';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const CHUNKS_TABLE = process.env['CHUNKS_TABLE']!;
// VIDEOS_TABLE is read directly by shared/clipBoundaries.ts (fetchSubjectSpeaker) —
// still required in this Lambda's env (CDK still sets it), just no longer referenced
// here by name now that refineClipBoundaries lives in the shared module.

// ── Principle-bridge fallback retrieval — feature flag + shadow mode ─────────
//
// Both default to the safest state. ENABLE_PRINCIPLE_BRIDGE defaults OFF, so
// none of Stage 2/3 below ever runs unless explicitly turned on. Even when it
// is on, SHADOW_MODE defaults ON (must be explicitly set to 'false' to go
// live) — Stage 2 still runs and gets logged, but the trustee always sees the
// same response Stage 1 alone would have produced. See
// claude-code-instructions-principle-bridge-retrieval-v2.md.
const ENABLE_PRINCIPLE_BRIDGE = process.env['ENABLE_PRINCIPLE_BRIDGE'] === 'true';
const SHADOW_MODE = process.env['SHADOW_MODE'] !== 'false';

// Stage 1 "confident direct match" floor, and Stage 2 "related principle" floor.
// Both are only ever consulted inside the ENABLE_PRINCIPLE_BRIDGE branch — the
// flag-off path below has no threshold at all, exactly as it does today.
const DIRECT_MATCH_THRESHOLD = 0.82;
const RELATED_PRINCIPLE_FLOOR = 0.55;
const RELATED_PRINCIPLE_MAX_RESULTS = 2;

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

interface DirectMatchResult {
  answer: string;
  citations: Citation[];
  topScore: number;   // raw top Pinecone similarity, 0 when there were no matches at all
  matchCount: number;
}

// Stage 1 — direct match. This is today's entire retrieval/answer pipeline,
// unchanged. It is always run (both when the principle-bridge flag is off,
// and — to get today's answer plus the score needed to decide whether Stage 2
// should even attempt to run — when it's on).
async function runDirectMatch(
  clientId: string,
  question: string,
  embedding: number[],
): Promise<DirectMatchResult> {
  // Step 2: Retrieve the most relevant transcript chunks from Pinecone.
  // The namespace equals clientId — data isolation is enforced at both
  // the JWT layer (withClientIsolation) and the vector DB layer (namespace).
  const matches = deduplicateMatches(
    await searchChunks(clientId, embedding, 3, { is_subject: true }),
  );

  const topScore = matches[0]?.score ?? 0;

  if (matches.length === 0) {
    return {
      answer:
        "I don't have any relevant transcript excerpts to answer this question. " +
        "This topic may not have been covered in the recorded interviews.",
      citations: [],
      topScore,
      matchCount: 0,
    };
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
  // speaker labels.
  const refinedMatches = await refineClipBoundaries(clientId, mergedMatches, embedding);
  const citations = buildCitations(refinedMatches, usedCitationIndices);

  return { answer, citations, topScore, matchCount: matches.length };
}

interface Stage2Result {
  type: 'related_principle' | 'none';
  answer: string;
  citations: Citation[];
  themes: string[];
}

const NONE_ANSWER =
  "This wasn't addressed directly in the interviews, and I couldn't find anything closely " +
  "related either. I don't want to guess at what your loved one would have wanted here — " +
  "this may be a good question to bring to the trustee or your family directly.";

// Stage 2 — principle-bridge fallback. Only ever called when
// ENABLE_PRINCIPLE_BRIDGE is on and Stage 1 did not clear DIRECT_MATCH_THRESHOLD.
async function runPrincipleBridge(
  clientId: string,
  question: string,
  embedding: number[],
): Promise<Stage2Result> {
  const themes = await classifyQuestionThemes(question);
  if (themes.length === 0) {
    return { type: 'none', answer: NONE_ANSWER, citations: [], themes: [] };
  }

  const filtered = deduplicateMatches(
    await searchChunks(clientId, embedding, 3, { is_subject: true, themes: { $in: themes } }),
  );

  // Stage 3: floor similarity even on the theme-filtered pass — don't force a
  // weak match just because it happens to share a theme tag.
  if (filtered.length === 0 || (filtered[0]?.score ?? 0) < RELATED_PRINCIPLE_FLOOR) {
    return { type: 'none', answer: NONE_ANSWER, citations: [], themes };
  }

  // Rank by tag overlap, then similarity as tiebreaker (per the doc's Stage 2
  // spec), then cap.
  const ranked = filtered
    .map(m => ({ match: m, overlap: (m.metadata.themes ?? []).filter(t => themes.includes(t)).length }))
    .sort((a, b) => b.overlap - a.overlap || b.match.score - a.match.score)
    .map(x => x.match)
    .slice(0, RELATED_PRINCIPLE_MAX_RESULTS);

  const refined = await refineClipBoundaries(clientId, ranked, embedding);

  const contextChunks = refined.map((m, i) => ({
    index: i + 1,
    text: m.metadata.text,
    video_id: m.metadata.video_id,
    start_time: m.metadata.start_time,
    end_time: m.metadata.end_time,
    speaker: m.metadata.speaker,
  }));

  const themeLabels = themes.map(t => findTheme(t)?.label).filter((l): l is string => !!l);
  const { answer, usedCitationIndices } = await queryRelatedPrinciple(question, contextChunks, themeLabels);
  const citations = buildCitations(refined, usedCitationIndices);

  // Claude may still decide, given the fixed framing rules, that none of the
  // provided excerpts are worth citing — treat that the same as "none".
  if (citations.length === 0) {
    return { type: 'none', answer: NONE_ANSWER, citations: [], themes };
  }

  return { type: 'related_principle', answer, citations, themes };
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
      const direct = await runDirectMatch(clientId, question, embedding);

      // ── Flag off (default): today's exact behavior, nothing else runs. ────
      if (!ENABLE_PRINCIPLE_BRIDGE) {
        void logQuery({ clientId, userEmail, question, citationCount: direct.citations.length })
          .catch(err => console.error('Failed to write query log:', err));
        return ok({ answer: direct.answer, citations: direct.citations });
      }

      // ── Flag on: decide direct vs. principle-bridge fallback. ─────────────
      let type: 'direct' | 'related_principle' | 'none';
      let liveAnswer: string;
      let liveCitations: Citation[];
      let themes: string[] = [];

      if (direct.matchCount > 0 && direct.topScore >= DIRECT_MATCH_THRESHOLD) {
        type = 'direct';
        liveAnswer = direct.answer;
        liveCitations = direct.citations;
      } else {
        const stage2 = await runPrincipleBridge(clientId, question, embedding);
        type = stage2.type;
        liveAnswer = stage2.answer;
        liveCitations = stage2.citations;
        themes = stage2.themes;
      }

      void logQuery({
        clientId,
        userEmail,
        question,
        citationCount: SHADOW_MODE ? direct.citations.length : liveCitations.length,
        shadowType: type,
        shadowThemes: themes,
      }).catch(err => console.error('Failed to write query log:', err));

      // Shadow mode: Stage 2 ran and was logged above, but the trustee always
      // sees exactly what Stage 1 alone would have returned.
      if (SHADOW_MODE) {
        return ok({ answer: direct.answer, citations: direct.citations });
      }

      return ok({ answer: liveAnswer, citations: liveCitations, type });
    } catch (err) {
      console.error('Query pipeline failed:', err);
      return internalError();
    }
  },
);
