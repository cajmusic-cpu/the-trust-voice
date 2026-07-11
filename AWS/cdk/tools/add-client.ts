#!/usr/bin/env ts-node
'use strict';
//
// add-client — provision AWS resources for a new Trust Voice client.
//
// Usage:
//   npm run add-client -- <clientId> "<clientName>"
//
// Example:
//   npm run add-client -- f47ac10b-58cc-4372-a567-0e02b2c3d479 "Margaret Chen"
//
// Creates (idempotent — safe to re-run if something failed partway through):
//   - ttv-{clientId}-videos S3 bucket
//       versioned, SSE-S3 encrypted, all public access blocked, SSL-only bucket policy
//       CORS: PUT from https://upload.thetrustvoice.com
//       S3 ObjectCreated notification → ttv-ingest Lambda
//   - ttv-{clientId}-transcripts S3 bucket
//       versioned, SSE-S3 encrypted, all public access blocked, SSL-only bucket policy
//       S3 ObjectCreated *.json notification → ttv-process-transcript Lambda
//   - Cognito user pool group named <clientId> with description <clientName>
//
// After running this tool:
//   1. Add the client to AWS/cdk/lib/config/clients.ts
//   2. Run `npm run cdk -- deploy` to update the CLIENTS_JSON env var on ttv-me Lambda
//   3. Assign trustees to the new Cognito group via the AWS console or CLI
//

import {
  S3Client,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketVersioningCommand,
  PutBucketEncryptionCommand,
  PutBucketPolicyCommand,
  PutBucketCorsCommand,
  PutBucketLoggingCommand,
  PutBucketNotificationConfigurationCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import {
  CognitoIdentityProviderClient,
  CreateGroupCommand,
  GetGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const REGION = 'us-east-1';
const STACK_NAME = 'TrustVoiceStack';

const [clientId, ...nameParts] = process.argv.slice(2);
const clientName = nameParts.join(' ');

if (!clientId || !clientName) {
  console.error('Usage: npm run add-client -- <clientId> "<clientName>"');
  console.error('Example: npm run add-client -- f47ac10b-58cc-4372-a567-0e02b2c3d479 "Margaret Chen"');
  process.exit(1);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
if (!UUID_RE.test(clientId)) {
  console.error(`clientId must be a UUID. Got: "${clientId}"`);
  console.error('Generate one at https://www.uuidgenerator.net/');
  process.exit(1);
}

const s3 = new S3Client({ region: REGION });
const cognito = new CognitoIdentityProviderClient({ region: REGION });
const sts = new STSClient({ region: REGION });
const cfn = new CloudFormationClient({ region: REGION });

async function bucketExists(name: string): Promise<boolean> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: name }));
    return true;
  } catch {
    return false;
  }
}

async function groupExists(userPoolId: string, groupName: string): Promise<boolean> {
  try {
    await cognito.send(new GetGroupCommand({ UserPoolId: userPoolId, GroupName: groupName }));
    return true;
  } catch {
    return false;
  }
}

// SSL-only bucket policy — denies all requests that are not over TLS.
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

async function createBucket(name: string): Promise<void> {
  if (await bucketExists(name)) {
    console.log(`  ✓ ${name} already exists`);
    return;
  }
  await s3.send(new CreateBucketCommand({ Bucket: name }));
  console.log(`  ✓ Created ${name}`);
}

async function configureBucket(name: string): Promise<void> {
  await s3.send(new PutPublicAccessBlockCommand({
    Bucket: name,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    },
  }));

  await s3.send(new PutBucketVersioningCommand({
    Bucket: name,
    VersioningConfiguration: { Status: 'Enabled' },
  }));

  await s3.send(new PutBucketEncryptionCommand({
    Bucket: name,
    ServerSideEncryptionConfiguration: {
      Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
    },
  }));

  await s3.send(new PutBucketPolicyCommand({
    Bucket: name,
    Policy: sslOnlyPolicy(name),
  }));

  await s3.send(new PutBucketLoggingCommand({
    Bucket: name,
    BucketLoggingStatus: {
      LoggingEnabled: {
        TargetBucket: 'ttv-access-logs-595028889888',
        TargetPrefix: `${name}/`,
      },
    },
  }));

  console.log(`  ✓ Configured ${name} (public access blocked, versioning, encryption, SSL-only policy, access logging)`);
}

async function main(): Promise<void> {
  console.log(`\nAdding client: ${clientName} (${clientId})\n`);

  // ── Resolve account ID and stack outputs ──────────────────────────────────

  const { Account: accountId } = await sts.send(new GetCallerIdentityCommand({}));
  console.log(`Account: ${accountId}  Region: ${REGION}`);

  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
  const outputs = Object.fromEntries(
    (Stacks?.[0]?.Outputs ?? []).map(o => [o.OutputKey!, o.OutputValue!]),
  );

  const userPoolId = outputs['UserPoolId'];
  if (!userPoolId) {
    throw new Error(
      `Could not read UserPoolId from CloudFormation stack "${STACK_NAME}". ` +
      'Make sure the stack is deployed and you are using the correct AWS credentials.',
    );
  }

  const ingestArn = `arn:aws:lambda:${REGION}:${accountId}:function:ttv-ingest`;
  const processArn = `arn:aws:lambda:${REGION}:${accountId}:function:ttv-process-transcript`;

  // ── Video bucket ──────────────────────────────────────────────────────────

  const videoBucket = `ttv-${clientId}-videos`;
  console.log(`\nVideo bucket: ${videoBucket}`);

  await createBucket(videoBucket);
  await configureBucket(videoBucket);

  // CORS: allow PUT from the upload portal (videographers upload directly to S3)
  await s3.send(new PutBucketCorsCommand({
    Bucket: videoBucket,
    CORSConfiguration: {
      CORSRules: [{
        AllowedMethods: ['PUT'],
        AllowedOrigins: ['https://upload.thetrustvoice.com'],
        AllowedHeaders: ['*'],
        MaxAgeSeconds: 3000,
      }],
    },
  }));
  console.log(`  ✓ CORS configured for upload.thetrustvoice.com`);

  // S3 notification → ttv-ingest Lambda on every new object
  await s3.send(new PutBucketNotificationConfigurationCommand({
    Bucket: videoBucket,
    NotificationConfiguration: {
      LambdaFunctionConfigurations: [{
        LambdaFunctionArn: ingestArn,
        Events: ['s3:ObjectCreated:*'],
      }],
    },
  }));
  console.log(`  ✓ S3 notification → ttv-ingest Lambda`);

  // ── Transcript bucket ─────────────────────────────────────────────────────

  const transcriptBucket = `ttv-${clientId}-transcripts`;
  console.log(`\nTranscript bucket: ${transcriptBucket}`);

  await createBucket(transcriptBucket);
  await configureBucket(transcriptBucket);

  // S3 notification → ttv-process-transcript Lambda, .json files only
  await s3.send(new PutBucketNotificationConfigurationCommand({
    Bucket: transcriptBucket,
    NotificationConfiguration: {
      LambdaFunctionConfigurations: [{
        LambdaFunctionArn: processArn,
        Events: ['s3:ObjectCreated:*'],
        Filter: {
          Key: { FilterRules: [{ Name: 'suffix', Value: '.json' }] },
        },
      }],
    },
  }));
  console.log(`  ✓ S3 notification → ttv-process-transcript Lambda (.json)`);

  // ── Cognito group ─────────────────────────────────────────────────────────

  console.log(`\nCognito group: ${clientId}`);

  if (await groupExists(userPoolId, clientId)) {
    console.log(`  ✓ Group already exists`);
  } else {
    await cognito.send(new CreateGroupCommand({
      UserPoolId: userPoolId,
      GroupName: clientId,
      Description: clientName,
    }));
    console.log(`  ✓ Created group`);
  }

  // ── Done ──────────────────────────────────────────────────────────────────

  console.log(`
┌─────────────────────────────────────────────────────────────────┐
  Client "${clientName}" provisioned successfully.

  Next steps:
    1. Add to AWS/cdk/lib/config/clients.ts:
       { id: '${clientId}', name: '${clientName}' }

    2. Deploy CDK to update the portal client list:
       npm run cdk -- deploy

    3. Assign trustees to the Cognito group:
       aws cognito-idp admin-add-user-to-group \\
         --user-pool-id ${userPoolId} \\
         --username <email> \\
         --group-name ${clientId}
└─────────────────────────────────────────────────────────────────┘
`);
}

main().catch(err => {
  console.error('\nError:', (err as Error).message);
  process.exit(1);
});
