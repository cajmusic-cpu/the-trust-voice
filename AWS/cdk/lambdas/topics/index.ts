// "Explore by Topic" browse view — GET /clients/{clientId}/topics
//
// A third, independent path alongside Stage 1 (direct match) and Stage 2
// (principle-bridge fallback): a persistent, always-visible index of the
// grantor's answers grouped by theme. Read-only. No AI judgment calls, no
// similarity scoring, no thresholds — it displays existing theme-tagged
// content grouped by tag, nothing more. No feature flag: unlike Stage 2 there
// is no auto-generated answer here to gate, just organized existing content.
//
// Does not touch Stage 1/2 retrieval logic, transcript chunking, or
// ingestion. For the common case — a chunk with 0 or 1 subject speech block —
// reuses shared/clipBoundaries.ts's refineClipBoundaries (the same trimming a
// direct-match citation gets) with no query embedding, so the single/only
// block is used (see speakerBoundaries's doc comment). For a chunk with more
// than one block, shared/blockThemeClassifier.ts has already classified each
// block on its own at ingestion/backfill time — those persisted, sentence-
// precise boundaries are used directly, one citation per (block, theme) pair,
// so a theme only ever shows the block it actually came from. No AI call
// happens here either way — it's all pre-computed.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { withClientIsolation, type IsolationContext } from '../shared/withClientIsolation';
import { ok, internalError } from '../shared/response';
import { refineClipBoundaries } from '../shared/clipBoundaries';
import type { BlockThemes } from '../shared/blockThemeClassifier';
import { THEMES, type ThemeDef } from '../shared/themes';
import type { ChunkMatch } from '../shared/pinecone';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const CHUNKS_TABLE = process.env['CHUNKS_TABLE']!;

interface ChunkRow {
  video_id: string;
  chunk_index: number;
  start_time: number;
  end_time: number;
  speaker: string;
  text: string;
  sentences_json?: string;
  themes?: string[];  // absent on chunks ingested before tagging existed — treat as []
  block_themes?: BlockThemes[];  // present only for a chunk with >1 subject speech block
}

export interface TopicItem {
  videoId: string;
  startTime: number;
  endTime: number;
  speaker: string;
  quote: string;
}

export interface TopicGroup {
  key: string;
  section: string;
  label: string;
  count: number;
  items: TopicItem[];
}

interface TopicChunk extends TopicItem {
  themes: string[];
}

// Pure — no DynamoDB, no AWS clients. Groups already-trimmed chunks under every
// theme in the taxonomy, preserving taxonomy order and including zero-count
// themes so the frontend can render a clean "No answers on this topic yet"
// instead of omitting the category entirely.
export function groupByTheme(allThemes: ThemeDef[], chunks: TopicChunk[]): TopicGroup[] {
  return allThemes.map(t => {
    const items = chunks
      .filter(c => c.themes.includes(t.key))
      .map(({ videoId, startTime, endTime, speaker, quote }) => ({ videoId, startTime, endTime, speaker, quote }));
    return { key: t.key, section: t.section, label: t.label, count: items.length, items };
  });
}

async function fetchSubjectChunks(clientId: string): Promise<ChunkRow[]> {
  const res = await ddb.send(new QueryCommand({
    TableName: CHUNKS_TABLE,
    KeyConditionExpression: 'client_id = :c',
    FilterExpression: 'is_subject = :s',
    ExpressionAttributeValues: { ':c': clientId, ':s': true },
  }));
  return (res.Items ?? []) as ChunkRow[];
}

export const handler = withClientIsolation(
  async (
    _event: APIGatewayProxyEvent,
    { clientId }: IsolationContext,
  ): Promise<APIGatewayProxyResult> => {
    if (!clientId) return internalError();

    const chunks = await fetchSubjectChunks(clientId);

    const multiBlockChunks = chunks.filter(c => c.block_themes && c.block_themes.length > 0);
    const singleBlockChunks = chunks.filter(c => !c.block_themes || c.block_themes.length === 0);

    // Multi-block chunks: each block already carries its own theme tags and its
    // own sentence-precise boundaries (computed once, at classification time —
    // see shared/blockThemeClassifier.ts). One TopicChunk per block, so a theme
    // only ever surfaces the block it was actually tagged from.
    const topicChunksFromBlocks: TopicChunk[] = multiBlockChunks.flatMap(c =>
      (c.block_themes ?? []).map(b => ({
        videoId: c.video_id,
        startTime: b.startTime,
        endTime: b.endTime,
        speaker: c.speaker,
        quote: b.text,
        themes: b.themes,
      })),
    );

    // Single/no-block chunks (the common case): unchanged from before — wrap as
    // a ChunkMatch (score/values unused on this call path — no ranking or dedup
    // happens here, just boundary trimming) and trim with no query embedding, so
    // the one available block is used.
    const matches: ChunkMatch[] = singleBlockChunks.map(c => ({
      id: `${c.video_id}/${c.chunk_index}`,
      score: 0,
      values: [],
      metadata: {
        video_id: c.video_id,
        chunk_index: c.chunk_index,
        start_time: c.start_time,
        end_time: c.end_time,
        speaker: c.speaker,
        is_subject: true,
        text: c.text,
        sentences_json: c.sentences_json ?? '',
        themes: c.themes ?? [],
        block_themes_json: '',
      },
    }));

    const refined = await refineClipBoundaries(clientId, matches, undefined);

    const topicChunksFromSingle: TopicChunk[] = refined.map(m => ({
      videoId: m.metadata.video_id,
      startTime: m.metadata.start_time,
      endTime: m.metadata.end_time,
      speaker: m.metadata.speaker,
      quote: m.metadata.text,
      themes: m.metadata.themes ?? [],
    }));

    return ok({ themes: groupByTheme(THEMES, [...topicChunksFromSingle, ...topicChunksFromBlocks]) });
  },
);
