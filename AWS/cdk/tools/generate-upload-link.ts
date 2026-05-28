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
  const s3 = new S3Client({ region: 'us-east-1' });

  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: EXPIRES_SECONDS },
  );

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

Subject: Interview Upload Instructions — ${client!.name}

Hi,

Here is your secure link to upload the interview recording. No accounts
or special software are required — just follow the steps below.

────────────────────────────────────────
STEP 1 — Open a terminal

  Mac:     press Command + Space, type Terminal, press Enter
  Windows: press Windows + R, type cmd, press Enter

────────────────────────────────────────
STEP 2 — Navigate to your video file

  Type the following command and press Enter, replacing the path
  with the folder that contains your video:

    Mac:     cd /path/to/your/video/folder
    Windows: cd C:\\path\\to\\your\\video\\folder

  Mac shortcut: type  cd  (with a space), then drag the folder
  from Finder into the Terminal window and press Enter.

────────────────────────────────────────
STEP 3 — Upload the file

  Paste the command below into the terminal, replace
  your-video.mp4 with your actual filename, then press Enter:

    curl --upload-file "your-video.mp4" "${url}"

  A progress bar will appear. When it finishes, the upload is
  complete — you can close the terminal.

────────────────────────────────────────

This link expires ${expiresStr}.

It accepts one upload only and does not grant access to any other
files or data. If you run into any trouble, just reply to this
email and I'll help right away.

──────────────────── END EMAIL ────────────────────
`);
}

main().catch(err => {
  console.error('\nError generating upload link:', (err as Error).message);
  process.exit(1);
});
