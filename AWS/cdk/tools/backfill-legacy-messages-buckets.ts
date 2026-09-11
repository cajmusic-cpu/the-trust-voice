#!/usr/bin/env ts-node
'use strict';
//
// backfill-legacy-messages-buckets — create the ttv-{clientId}-legacy-messages
// bucket for every client already in clients.ts. New clients get this bucket
// automatically from `npm run add-client`; this one-off covers clients added
// before it existed. Idempotent — safe to re-run.
//
// Deliberately does NOT configure any S3 event notification on these buckets.
// Legacy-tier personal video messages must never enter the transcribe/chunk/
// embed pipeline — see tools/get-legacy-video.ts.
//
// Usage:
//   npm run backfill-legacy-buckets

import {
  S3Client,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketVersioningCommand,
  PutBucketEncryptionCommand,
  PutBucketPolicyCommand,
  PutBucketLoggingCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { CLIENTS } from '../lib/config/clients';

const REGION = 'us-east-1';
const s3 = new S3Client({ region: REGION });

async function bucketExists(name: string): Promise<boolean> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: name }));
    return true;
  } catch {
    return false;
  }
}

function sslOnlyPolicy(bucketName: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DenyNonTLS',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:*',
        Resource: [
          `arn:aws:s3:::${bucketName}`,
          `arn:aws:s3:::${bucketName}/*`,
        ],
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      },
    ],
  });
}

async function main(): Promise<void> {
  console.log(`Applying to ${CLIENTS.length} client(s):\n`);

  for (const client of CLIENTS) {
    const bucket = `ttv-${client.id}-legacy-messages`;
    console.log(`${client.name} (${client.id})`);

    if (await bucketExists(bucket)) {
      console.log(`  ✓ ${bucket} already exists`);
      continue;
    }

    await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    await s3.send(new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }));
    await s3.send(new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: 'Enabled' },
    }));
    await s3.send(new PutBucketEncryptionCommand({
      Bucket: bucket,
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
    }));
    await s3.send(new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: sslOnlyPolicy(bucket),
    }));
    await s3.send(new PutBucketLoggingCommand({
      Bucket: bucket,
      BucketLoggingStatus: {
        LoggingEnabled: {
          TargetBucket: 'ttv-access-logs-595028889888',
          TargetPrefix: `${bucket}/`,
        },
      },
    }));

    console.log(`  ✓ Created ${bucket} (public access blocked, versioning, encryption, SSL-only policy, access logging)`);
    console.log(`  ✓ No S3 event notification configured — by design`);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('\nError:', (err as Error).message);
  process.exit(1);
});
