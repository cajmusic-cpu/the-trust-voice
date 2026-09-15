#!/usr/bin/env ts-node
'use strict';
//
// backfill-theme-tags — classify every existing is_subject chunk against the
// theme taxonomy in lambdas/shared/themes.ts, for the principle-bridge
// fallback retrieval feature (Stage 2 is inert until ttv-query's
// ENABLE_PRINCIPLE_BRIDGE flag is turned on — this script is safe to run
// against real data any time).
//
// A chunk with more than one subject speech block (an interviewer question
// splitting two unrelated answers) is classified per-block, not once for the
// whole chunk — see lambdas/shared/blockThemeClassifier.ts for why. Chunks
// with 0 or 1 block (the large majority) are classified exactly as before:
// one whole-chunk call, no block_themes written.
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
// --multiblock-only: skips every chunk with 0 or 1 subject block entirely —
// no Claude call, no write, not counted. For a targeted re-run (e.g. after
// finding this exact class of clip-selection issue) that should only touch
// the handful of chunks actually capable of it.
//
// --additions-only: for re-validating a prompt/taxonomy change against
// already-tagged chunks. Every chunk still gets classified fresh and shown
// in the review CSV (with a previous_themes/added/removed diff against what
// was already stored), but with --apply, a chunk is only WRITTEN if nothing
// it already had got dropped — a chunk where the new classification would
// remove a previously-assigned theme is left untouched and reported as
// "SKIPPED (would drop ...)" for manual review instead. Safe to combine with
// --multiblock-only.
//
// Usage:
//   npm run backfill-theme-tags                                  # dry run -> CSV
//   npm run backfill-theme-tags -- --apply                       # writes tags for real
//   npm run backfill-theme-tags -- --client <id> [--apply]       # one client only
//   npm run backfill-theme-tags -- --client <id> --multiblock-only --apply   # only multi-block chunks
//   npm run backfill-theme-tags -- --client <id> --additions-only --apply    # only write chunks that gained a theme, none dropped

import { writeFileSync } from 'node:fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CLIENTS } from '../lib/config/clients';
import { findTheme } from '../lambdas/shared/themes';
import { updateChunkThemes } from '../lambdas/shared/pinecone';
import { findSubjectBlocks, fetchSubjectSpeaker } from '../lambdas/shared/clipBoundaries';
import { classifyChunkOrBlocks, type BlockThemes } from '../lambdas/shared/blockThemeClassifier';

const CHUNKS_TABLE = 'ttv-chunks';
const REGION = 'us-east-1';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const multiblockOnly = args.includes('--multiblock-only');
const additionsOnly = args.includes('--additions-only');
const clientArgIdx = args.indexOf('--client');
const onlyClientId = clientArgIdx >= 0 ? args[clientArgIdx + 1] : undefined;

interface ChunkRow {
  client_id: string;
  sk: string;
  video_id: string;
  chunk_index: number;
  is_subject: boolean;
  text: string;
  sentences_json?: string;
  pinecone_id: string;
  themes?: string[];
}

interface ReviewRow {
  client: string;
  video_id: string;
  chunk_index: number;
  blocks: number;
  previous_themes: string;
  themes: string;
  added: string;
  removed: string;
  write_status: string;
  scenario_specific: string;
  block_breakdown: string;
  excerpt: string;
}

function setDiff(a: string[], b: string[]): string[] {
  const sb = new Set(b);
  return a.filter(x => !sb.has(x));
}

function fmt(t: number): string {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
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
  const header = ['client', 'video_id', 'chunk_index', 'blocks', 'previous_themes', 'themes', 'added', 'removed', 'write_status', 'scenario_specific', 'block_breakdown', 'excerpt'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      csvCell(r.client),
      csvCell(r.video_id),
      String(r.chunk_index),
      String(r.blocks),
      csvCell(r.previous_themes),
      csvCell(r.themes),
      csvCell(r.added),
      csvCell(r.removed),
      csvCell(r.write_status),
      csvCell(r.scenario_specific),
      csvCell(r.block_breakdown),
      csvCell(r.excerpt),
    ].join(','));
  }
  return lines.join('\n');
}

function blockBreakdown(blockThemes: BlockThemes[] | null): string {
  if (!blockThemes) return '';
  return blockThemes
    .map(b => `${fmt(b.startTime)}-${fmt(b.endTime)}→${b.themes.join('+') || '(none)'}`)
    .join('; ');
}

async function main(): Promise<void> {
  const clients = onlyClientId ? CLIENTS.filter(c => c.id === onlyClientId) : CLIENTS;
  if (onlyClientId && clients.length === 0) {
    console.error(`Unknown client ID: "${onlyClientId}"`);
    process.exit(1);
  }

  console.log(
    `${apply ? 'APPLYING' : 'DRY RUN'}${multiblockOnly ? ' (multi-block chunks only)' : ''} — ` +
    `classifying is_subject chunks for ${clients.length} client(s)\n`,
  );

  const reviewRows: ReviewRow[] = [];
  let totalChunks = 0;
  let totalTagged = 0;
  let totalSkipped = 0;
  let totalSkippedForReview = 0;

  for (const client of clients) {
    const chunks = await fetchSubjectChunks(client.id);
    console.log(`${client.name} (${client.id}) — ${chunks.length} subject chunk(s)`);

    // Subject speaker is looked up once per video, not once per chunk.
    const subjectSpeakerByVideo = new Map<string, string | undefined>();
    for (const videoId of new Set(chunks.map(c => c.video_id))) {
      subjectSpeakerByVideo.set(videoId, await fetchSubjectSpeaker(client.id, videoId));
    }

    for (const chunk of chunks) {
      const subjectSpeaker = subjectSpeakerByVideo.get(chunk.video_id);
      const blocks = findSubjectBlocks(chunk.sentences_json, subjectSpeaker);

      if (multiblockOnly && blocks.length <= 1) {
        totalSkipped++;
        continue;
      }

      totalChunks++;
      const { themes, blockThemes } = await classifyChunkOrBlocks(chunk.text, chunk.sentences_json, subjectSpeaker);
      if (themes.length > 0) totalTagged++;

      const previousThemes = chunk.themes ?? [];
      const added = setDiff(themes, previousThemes);
      const removed = setDiff(previousThemes, themes);
      const skipForReview = additionsOnly && removed.length > 0;
      if (skipForReview) totalSkippedForReview++;

      const scenarioFlags = themes
        .map(t => findTheme(t))
        .filter(t => t?.scenarioSpecific)
        .map(t => t!.key);

      const writeStatus = !apply
        ? ''
        : skipForReview
          ? `SKIPPED (would drop: ${removed.join(', ')})`
          : 'written';

      reviewRows.push({
        client: client.name,
        video_id: chunk.video_id,
        chunk_index: chunk.chunk_index,
        blocks: blocks.length,
        previous_themes: previousThemes.join('; ') || '(none)',
        themes: themes.join('; ') || '(none)',
        added: added.join('; '),
        removed: removed.join('; '),
        write_status: writeStatus,
        scenario_specific: scenarioFlags.join('; '),
        block_breakdown: blockBreakdown(blockThemes),
        excerpt: chunk.text.slice(0, 160),
      });

      console.log(
        `  chunk ${chunk.chunk_index} (${blocks.length} block${blocks.length === 1 ? '' : 's'}): ` +
        `[${themes.join(', ') || 'none'}]${blockThemes ? ` — ${blockBreakdown(blockThemes)}` : ''}` +
        (writeStatus ? ` — ${writeStatus}` : ''),
      );

      if (apply && !skipForReview) {
        await ddb.send(new UpdateCommand({
          TableName: CHUNKS_TABLE,
          Key: { client_id: chunk.client_id, sk: chunk.sk },
          UpdateExpression: blockThemes ? 'SET themes = :t, block_themes = :bt' : 'SET themes = :t',
          ExpressionAttributeValues: blockThemes ? { ':t': themes, ':bt': blockThemes } : { ':t': themes },
        }));
        await updateChunkThemes(
          client.id,
          chunk.pinecone_id,
          themes,
          blockThemes ? JSON.stringify(blockThemes) : undefined,
        );
      }
    }
  }

  console.log(`\n${totalChunks} chunk(s) classified, ${totalTagged} got at least one theme.`);
  if (multiblockOnly) console.log(`${totalSkipped} single/no-block chunk(s) skipped entirely (--multiblock-only).`);
  if (additionsOnly) console.log(`${totalSkippedForReview} chunk(s) would drop an existing theme — left unwritten, flagged for manual review (--additions-only).`);

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
