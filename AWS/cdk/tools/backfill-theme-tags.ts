#!/usr/bin/env ts-node
'use strict';
//
// backfill-theme-tags — classify every existing is_subject chunk against the
// theme taxonomy in lambdas/shared/themes.ts, for the principle-bridge
// fallback retrieval feature (Stage 2 is inert until ttv-query's
// ENABLE_PRINCIPLE_BRIDGE flag is turned on — this script is safe to run
// against real data any time).
//
// Default: DRY RUN. Classifies every chunk and writes a review CSV — no
// writes to DynamoDB or Pinecone. Per the source doc, the taxonomy itself
// needs Deni/Scott sign-off before tags are used to influence anything a
// trustee could see; review the CSV first.
//
// --apply: writes the classified themes to both the DynamoDB ttv-chunks row
// (UpdateItem) and the Pinecone vector's metadata (metadata-only update —
// never touches the stored embedding). Re-runnable any time the taxonomy
// changes (see themes.ts's file header) — classification always runs fresh
// against the current table, never from a cached prior result.
//
// Usage:
//   npm run backfill-theme-tags                 # dry run -> CSV
//   npm run backfill-theme-tags -- --apply       # writes tags for real
//   npm run backfill-theme-tags -- --client <id> [--apply]   # one client only

import { writeFileSync } from 'node:fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CLIENTS } from '../lib/config/clients';
import { classifyChunkThemes } from '../lambdas/shared/themeClassifier';
import { findTheme } from '../lambdas/shared/themes';
import { updateChunkThemes } from '../lambdas/shared/pinecone';

const CHUNKS_TABLE = 'ttv-chunks';
const REGION = 'us-east-1';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const clientArgIdx = args.indexOf('--client');
const onlyClientId = clientArgIdx >= 0 ? args[clientArgIdx + 1] : undefined;

interface ChunkRow {
  client_id: string;
  sk: string;
  video_id: string;
  chunk_index: number;
  is_subject: boolean;
  text: string;
  pinecone_id: string;
  themes?: string[];
}

interface ReviewRow {
  client: string;
  video_id: string;
  chunk_index: number;
  themes: string;
  scenario_specific: string;
  excerpt: string;
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

function csvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return /[",\n]/.test(value) ? `"${escaped}"` : escaped;
}

function toCsv(rows: ReviewRow[]): string {
  const header = ['client', 'video_id', 'chunk_index', 'themes', 'scenario_specific', 'excerpt'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      csvCell(r.client),
      csvCell(r.video_id),
      String(r.chunk_index),
      csvCell(r.themes),
      csvCell(r.scenario_specific),
      csvCell(r.excerpt),
    ].join(','));
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const clients = onlyClientId ? CLIENTS.filter(c => c.id === onlyClientId) : CLIENTS;
  if (onlyClientId && clients.length === 0) {
    console.error(`Unknown client ID: "${onlyClientId}"`);
    process.exit(1);
  }

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — classifying is_subject chunks for ${clients.length} client(s)\n`);

  const reviewRows: ReviewRow[] = [];
  let totalChunks = 0;
  let totalTagged = 0;

  for (const client of clients) {
    const chunks = await fetchSubjectChunks(client.id);
    console.log(`${client.name} (${client.id}) — ${chunks.length} subject chunk(s)`);

    for (const chunk of chunks) {
      totalChunks++;
      const themes = await classifyChunkThemes(chunk.text);
      if (themes.length > 0) totalTagged++;

      const scenarioFlags = themes
        .map(t => findTheme(t))
        .filter(t => t?.scenarioSpecific)
        .map(t => t!.key);

      reviewRows.push({
        client: client.name,
        video_id: chunk.video_id,
        chunk_index: chunk.chunk_index,
        themes: themes.join('; ') || '(none)',
        scenario_specific: scenarioFlags.join('; '),
        excerpt: chunk.text.slice(0, 160),
      });

      console.log(`  chunk ${chunk.chunk_index}: [${themes.join(', ') || 'none'}]`);

      if (apply) {
        await ddb.send(new UpdateCommand({
          TableName: CHUNKS_TABLE,
          Key: { client_id: chunk.client_id, sk: chunk.sk },
          UpdateExpression: 'SET themes = :t',
          ExpressionAttributeValues: { ':t': themes },
        }));
        await updateChunkThemes(client.id, chunk.pinecone_id, themes);
      }
    }
  }

  console.log(`\n${totalChunks} chunk(s) classified, ${totalTagged} got at least one theme.`);

  if (!apply) {
    const csvPath = `theme-tags-review-${new Date().toISOString().slice(0, 10)}.csv`;
    writeFileSync(csvPath, toCsv(reviewRows));
    console.log(`\nDry run only — nothing written to DynamoDB or Pinecone.`);
    console.log(`Review CSV written to: ${csvPath}`);
    console.log(`Once the taxonomy (lambdas/shared/themes.ts) and this CSV look right, re-run with --apply.`);
  } else {
    console.log(`\nWrote themes to DynamoDB (ttv-chunks) and Pinecone metadata for all classified chunks.`);
  }
}

main().catch(err => {
  console.error('\nError:', (err as Error).message);
  process.exit(1);
});
