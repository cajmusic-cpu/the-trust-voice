#!/usr/bin/env ts-node
'use strict';
//
// backfill-video-cors — apply the current video-bucket CORS config to every
// existing ttv-*-videos bucket.
//
// New buckets get this automatically from `npm run add-client`. This one-off
// covers buckets created before GET/HEAD playback CORS was added. Idempotent —
// safe to re-run.
//
// Usage:
//   npm run backfill-video-cors             # apply to all ttv-*-videos buckets
//   npm run backfill-video-cors -- --dry-run

import {
  S3Client,
  ListBucketsCommand,
  PutBucketCorsCommand,
  GetBucketCorsCommand,
} from '@aws-sdk/client-s3';
import { VIDEO_BUCKET_CORS_RULES } from './video-bucket-cors';

const REGION = 'us-east-1';
const dryRun = process.argv.includes('--dry-run');
const s3 = new S3Client({ region: REGION });

const VIDEO_BUCKET_RE = /^ttv-[0-9a-f-]{36}-videos$/;

async function main(): Promise<void> {
  const { Buckets = [] } = await s3.send(new ListBucketsCommand({}));
  const targets = Buckets
    .map((b) => b.Name ?? '')
    .filter((name) => VIDEO_BUCKET_RE.test(name));

  if (targets.length === 0) {
    console.log('No ttv-*-videos buckets found.');
    return;
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}Applying CORS to ${targets.length} bucket(s):\n`);

  for (const bucket of targets) {
    let before = '(none)';
    try {
      const current = await s3.send(new GetBucketCorsCommand({ Bucket: bucket }));
      before = JSON.stringify(current.CORSRules);
    } catch {
      // No CORS configured yet — that's fine.
    }

    if (dryRun) {
      console.log(`  ${bucket}\n    before: ${before}`);
      continue;
    }

    await s3.send(new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: { CORSRules: VIDEO_BUCKET_CORS_RULES },
    }));
    console.log(`  ✓ ${bucket}`);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('\nError:', (err as Error).message);
  process.exit(1);
});
