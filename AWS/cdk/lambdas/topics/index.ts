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
// ingestion. Reuses shared/clipBoundaries.ts's refineClipBoundaries (the same
// trimming a direct-match citation gets) with no query embedding — there's no
// question here, so the largest subject block in a chunk is used instead of
// the closest-to-the-query one (see speakerBoundaries's doc comment).

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { withClientIsolation, type IsolationContext } from '../shared/withClientIsolation';
import { ok, internalError } from '../shared/response';
import { refineClipBoundaries } from '../shared/clipBoundaries';
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

    // Wrap DynamoDB rows in the same shape refineClipBoundaries already knows
    // how to trim (score/values are unused on this call path — no ranking or
    // dedup happens here, just boundary trimming per chunk).
    const matches: ChunkMatch[] = chunks.map(c => ({
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
      },
    }));

    const refined = await refineClipBoundaries(clientId, matches, undefined);

    const topicChunks: TopicChunk[] = refined.map(m => ({
      videoId: m.metadata.video_id,
      startTime: m.metadata.start_time,
      endTime: m.metadata.end_time,
      speaker: m.metadata.speaker,
      quote: m.metadata.text,
      themes: m.metadata.themes ?? [],
    }));

    return ok({ themes: groupByTheme(THEMES, topicChunks) });
  },
);
