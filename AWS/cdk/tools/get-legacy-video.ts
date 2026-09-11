#!/usr/bin/env ts-node
'use strict';
//
// get-legacy-video — retrieve a client's Legacy-tier personal video message
// backup from S3 (ttv-{clientId}-legacy-messages), e.g. when a client loses
// their USB drive. Admin-only: run locally with your own AWS credentials.
// This tool has no deployed counterpart — no Lambda, no API Gateway route,
// nothing reachable from the portal or the AI query pipeline. That isolation
// is structural, not just a convention this script follows:
//   - the legacy-messages bucket is never wired to any S3 event notification,
//     so nothing can trigger the transcribe/chunk/embed pipeline on it;
//   - the bucket name does not end in "-videos" or "-transcripts", so it
//     falls outside every ttv-*-videos / ttv-*-transcripts IAM grant already
//     given to the ingest/mediaconvert/video-url Lambda roles;
//   - ttv-query-lambda-role (the RAG path) has no S3 permissions at all —
//     it can only ever surface what has been embedded into Pinecone, and
//     these files are never embedded.
//
// Usage:
//   npm run legacy-video -- list <clientNameOrId>
//   npm run legacy-video -- link <clientNameOrId> <key> [--hours N]      (default 24, max 168)
//   npm run legacy-video -- download <clientNameOrId> <key> [outPath]
//
// Examples:
//   npm run legacy-video -- list "Lisa Satterfield"
//   npm run legacy-video -- link "Lisa Satterfield" for-margaret.mp4 --hours 48
//   npm run legacy-video -- download 594292a9-7704-4507-9f53-4de7eaf34657 for-margaret.mp4

import { createWriteStream } from 'fs';
import { resolve as resolvePath } from 'path';
import { Readable } from 'stream';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { CLIENTS, type ClientConfig } from '../lib/config/clients';

const REGION = 'us-east-1';
const DEFAULT_EXPIRES_HOURS = 24;
const MAX_EXPIRES_HOURS = 168; // 7 days — S3 presigned-URL ceiling with IAM-user credentials

const s3 = new S3Client({ region: REGION });

// ─── Client resolution (by UUID or case-insensitive name substring) ──────────

function resolveClient(query: string): ClientConfig {
  const byId = CLIENTS.find(c => c.id === query);
  if (byId) return byId;

  const q = query.trim().toLowerCase();
  const matches = CLIENTS.filter(c => c.name.toLowerCase().includes(q));
  if (matches.length === 1) return matches[0]!;

  if (matches.length === 0) {
    console.error(`No client matches "${query}".\n`);
  } else {
    console.error(`"${query}" matches more than one client — be more specific:\n`);
    matches.forEach(c => console.error(`  ${c.name}  (${c.id})`));
    console.error('');
  }
  console.error('Known clients:');
  CLIENTS.forEach(c => console.error(`  ${c.name}  (${c.id})`));
  process.exit(1);
}

function bucketFor(client: ClientConfig): string {
  return `ttv-${client.id}-legacy-messages`;
}

async function requireBucket(bucket: string): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    console.error(`\nBucket ${bucket} does not exist yet.`);
    console.error('Run `npm run backfill-legacy-buckets` (existing clients) or `npm run add-client` (new clients) first.');
    process.exit(1);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdList(client: ClientConfig): Promise<void> {
  const bucket = bucketFor(client);
  await requireBucket(bucket);

  const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  const objects = res.Contents ?? [];

  console.log(`\nLegacy messages for ${client.name} (${bucket}):\n`);
  if (objects.length === 0) {
    console.log('  (none stored yet)');
    return;
  }
  for (const obj of objects) {
    const sizeMb = ((obj.Size ?? 0) / (1024 * 1024)).toFixed(1);
    console.log(`  ${obj.Key}    ${sizeMb} MB    modified ${obj.LastModified?.toISOString().slice(0, 10)}`);
  }
  console.log(`\nUse the key shown above with: npm run legacy-video -- link "${client.name}" <key>`);
}

async function cmdLink(client: ClientConfig, key: string, hoursArg?: string): Promise<void> {
  const bucket = bucketFor(client);
  await requireBucket(bucket);

  let hours = hoursArg ? Number(hoursArg) : DEFAULT_EXPIRES_HOURS;
  if (!Number.isFinite(hours) || hours <= 0) hours = DEFAULT_EXPIRES_HOURS;
  if (hours > MAX_EXPIRES_HOURS) {
    console.error(`--hours capped at ${MAX_EXPIRES_HOURS} (7 days); using that instead of ${hours}.`);
    hours = MAX_EXPIRES_HOURS;
  }

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: Math.round(hours * 3600) },
  );

  const expiresAt = new Date(Date.now() + hours * 3600 * 1000);
  const expiresStr = expiresAt.toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });

  console.log(`
┌─────────────────────────────────────────────────────────────────┐
  Client:   ${client.name}
  Bucket:   ${bucket}
  Key:      ${key}
  Expires:  ${expiresStr} (${hours}h from now)
└─────────────────────────────────────────────────────────────────┘

──────────────────── COPY MESSAGE BELOW ────────────────────

Hi — here's a secure link to download your video message. This link is
private to you and expires ${expiresStr.split(' at ')[0] ?? 'soon'}, so please
save the file somewhere safe once downloaded.

  ${url}

──────────────────── END MESSAGE ────────────────────
`);
}

async function cmdDownload(client: ClientConfig, key: string, outPathArg?: string): Promise<void> {
  const bucket = bucketFor(client);
  await requireBucket(bucket);

  const outPath = resolvePath(outPathArg || key.split('/').pop() || 'legacy-video.mp4');

  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = res.Body;
  if (!(body instanceof Readable)) {
    throw new Error('Unexpected S3 response body type — expected a Node.js stream.');
  }

  await new Promise<void>((resolveDl, reject) => {
    const out = createWriteStream(outPath);
    body.pipe(out);
    body.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolveDl);
  });

  console.log(`\n✓ Downloaded ${key} → ${outPath} (${res.ContentLength ? (res.ContentLength / (1024 * 1024)).toFixed(1) + ' MB' : 'size unknown'})`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

function usage(): never {
  console.error('Usage:');
  console.error('  npm run legacy-video -- list <clientNameOrId>');
  console.error('  npm run legacy-video -- link <clientNameOrId> <key> [--hours N]');
  console.error('  npm run legacy-video -- download <clientNameOrId> <key> [outPath]');
  process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, clientQuery, ...rest] = process.argv.slice(2);
  if (!cmd || !clientQuery) usage();

  const client = resolveClient(clientQuery);

  if (cmd === 'list') {
    return cmdList(client);
  }

  if (cmd === 'link') {
    const [key, ...flags] = rest;
    if (!key) usage();
    const hoursIdx = flags.indexOf('--hours');
    const hours = hoursIdx >= 0 ? flags[hoursIdx + 1] : undefined;
    return cmdLink(client, key, hours);
  }

  if (cmd === 'download') {
    const [key, outPath] = rest;
    if (!key) usage();
    return cmdDownload(client, key, outPath);
  }

  usage();
}

main().catch(err => {
  console.error('\nError:', (err as Error).message);
  process.exit(1);
});
