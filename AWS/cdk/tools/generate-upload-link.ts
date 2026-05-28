#!/usr/bin/env ts-node
'use strict';

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID, randomBytes } from 'crypto';
import { CLIENTS } from '../lib/config/clients';

const EXPIRES_SECONDS = 48 * 60 * 60; // 48 hours
const UPLOAD_TOKENS_TABLE = 'ttv-upload-tokens';

// ─── Args ─────────────────────────────────────────────────────────────────────

const [clientId, ...noteParts] = process.argv.slice(2);
const note = noteParts.join(' ');

function listClients(): void {
  console.error('\nKnown clients:');
  CLIENTS.forEach(c => console.error(`  ${c.id}  (${c.name})`));
}

if (!clientId) {
  console.error('Usage: npm run upload-link -- <clientId> [note]');
  console.error('       npm run upload-link -- 5fbc7625-d566-4ec5-93f4-b82f52ad17bc "Caldwell shoot — June 2026"');
  listClients();
  process.exit(1);
}

const client = CLIENTS.find(c => c.id === clientId);
if (!client) {
  console.error(`Unknown client ID: "${clientId}"`);
  listClients();
  process.exit(1);
}

// ─── Generate link ────────────────────────────────────────────────────────────

const videoId = randomUUID();
const bucket = `ttv-${clientId}-videos`;
const key = `${videoId}/interview.mp4`;

// 12 alphanumeric chars — short enough to survive any email client, unique enough
// to be unguessable (2^71 combinations with base-62 charset).
function makeToken(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(randomBytes(12)).map(b => chars[b % chars.length]).join('');
}

async function main(): Promise<void> {
  // requestChecksumCalculation: 'WHEN_REQUIRED' prevents the SDK from embedding
  // a CRC32 checksum in the presigned URL. Without this, the URL includes an
  // x-amz-checksum-crc32 query parameter signed against an empty payload, which
  // would cause S3 to reject any non-empty upload from a browser.
  const s3 = new S3Client({
    region: 'us-east-1',
    requestChecksumCalculation: 'WHEN_REQUIRED' as never,
  });

  const presignedS3Url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: EXPIRES_SECONDS },
  );

  // Store presigned URL behind a short token so the email link stays short and
  // survives any email client that wraps or truncates long URLs.
  const token = makeToken();
  const expiresAtEpoch = Math.floor(Date.now() / 1000) + EXPIRES_SECONDS;

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
  await ddb.send(new PutCommand({
    TableName: UPLOAD_TOKENS_TABLE,
    Item: { token, presigned_url: presignedS3Url, expires_at: expiresAtEpoch },
  }));

  const url = `https://upload.thetrustvoice.com?token=${token}`;

  const expiresAt = new Date(Date.now() + EXPIRES_SECONDS * 1000);
  const expiresStr = expiresAt.toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const meta = [
    `Client:   ${client!.name}`,
    note ? `Note:     ${note}` : '',
    `Token:    ${token}`,
    `Video ID: ${videoId}`,
    `Bucket:   ${bucket}`,
    `Key:      ${key}`,
    `Expires:  ${expiresStr}`,
  ].filter(Boolean).join('\n  ');

  console.log(`
┌─────────────────────────────────────────────────────────────────┐
  ${meta}
└─────────────────────────────────────────────────────────────────┘

──────────────────── COPY EMAIL BELOW ────────────────────

Subject: Interview Upload Link — ${client!.name}

Hi,

Please use the link below to upload the interview recording. No account
or software installation is required — just click the link, select your
file, and upload.

  ${url}

HOW TO UPLOAD

  1. Click the link above (or copy and paste it into your browser).
  2. On the upload page, click "Select file" or drag your video file
     onto the page.
  3. Click "Upload Recording" and wait for the progress bar to reach
     100%. Do not close the browser tab until it completes.

This link expires ${expiresStr}.
It can be used once and does not provide access to any other files.

If you have any trouble, reply to this email and I'll help right away.

──────────────────── END EMAIL ────────────────────
`);
}

main().catch(err => {
  console.error('\nError generating upload link:', (err as Error).message);
  process.exit(1);
});
