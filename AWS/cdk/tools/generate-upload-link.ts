#!/usr/bin/env ts-node
'use strict';

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { CLIENTS } from '../lib/config/clients';

const EXPIRES_SECONDS = 48 * 60 * 60; // 48 hours

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

  const url = `https://upload.thetrustvoice.com?url=${encodeURIComponent(presignedS3Url)}`;

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
