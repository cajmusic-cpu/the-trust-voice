#!/usr/bin/env ts-node
'use strict';
//
// reprocess-video — delete existing chunks and re-index a video's transcript.
//
// Use this after changing MAX_WORDS in chunk.ts to apply the new chunk size
// to an already-processed video without re-uploading or re-transcribing.
//
// Usage:
//   npm run reprocess-video -- <clientId> <videoId>
//
// Example:
//   npm run reprocess-video -- a5be0dd6-14b9-4a47-a5bf-7440bdc7eb85 d4580cda-ceb0-4f6a-bb14-407c5839ce07
//
// Steps performed:
//   1. Query DynamoDB for all chunk records and delete them (BatchWriteItem)
//   2. Delete corresponding Pinecone vectors by ID
//   3. Invoke ttv-process-transcript Lambda with the existing S3 transcript
//      (Lambda re-chunks, re-embeds, re-writes DynamoDB and Pinecone)
//

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { Pinecone } from '@pinecone-database/pinecone';

const REGION = 'us-east-1';
const CHUNKS_TABLE = 'ttv-chunks';
const PINECONE_INDEX_NAME = 'ttv-embeddings';
const PINECONE_INDEX_HOST = 'https://ttv-embeddings-he5dsra.svc.aped-4627-b74a.pinecone.io';
const PINECONE_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:595028889888:secret:ttv/pinecone-api-key-oOAOom';
const PROCESS_FN = 'ttv-process-transcript';

async function getPineconeKey(): Promise<string> {
  const sm = new SecretsManagerClient({ region: REGION });
  const res = await sm.send(new GetSecretValueCommand({ SecretId: PINECONE_SECRET_ARN }));
  if (!res.SecretString) throw new Error('Pinecone secret missing string value');
  return (JSON.parse(res.SecretString) as { api_key: string }).api_key;
}

async function deleteChunksDynamo(clientId: string, videoId: string): Promise<number> {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const skPrefix = `VIDEO#${videoId}#CHUNK#`;
  const keys: Array<{ client_id: string; sk: string }> = [];

  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: CHUNKS_TABLE,
      KeyConditionExpression: 'client_id = :cid AND begins_with(sk, :pfx)',
      ExpressionAttributeValues: { ':cid': clientId, ':pfx': skPrefix },
      ProjectionExpression: 'client_id, sk',
      ExclusiveStartKey: lastKey,
    }));
    for (const item of res.Items ?? []) {
      keys.push({ client_id: item['client_id'] as string, sk: item['sk'] as string });
    }
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  // BatchWriteItem max 25 per call
  for (let i = 0; i < keys.length; i += 25) {
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [CHUNKS_TABLE]: keys.slice(i, i + 25).map(k => ({ DeleteRequest: { Key: k } })),
      },
    }));
  }
  return keys.length;
}

async function deleteVectorsPinecone(clientId: string, videoId: string, count: number): Promise<void> {
  const apiKey = await getPineconeKey();
  const pc = new Pinecone({ apiKey });
  const ns = pc.index(PINECONE_INDEX_NAME, PINECONE_INDEX_HOST).namespace(clientId);
  const ids = Array.from({ length: count }, (_, i) => `${videoId}/${i}`);
  // deleteMany limit is 1000 per call
  for (let i = 0; i < ids.length; i += 1000) {
    await ns.deleteMany(ids.slice(i, i + 1000));
  }
}

async function invokeProcessTranscript(clientId: string, videoId: string): Promise<void> {
  const bucket = `ttv-${clientId}-transcripts`;
  const key = `${videoId}/ttv-${videoId}.json`;
  const payload = JSON.stringify({
    Records: [{ s3: { bucket: { name: bucket }, object: { key } } }],
  });

  const lambda = new LambdaClient({ region: REGION });
  // Event = async invocation; Lambda runs in background (~1-3 min for a 2hr interview)
  const res = await lambda.send(new InvokeCommand({
    FunctionName: PROCESS_FN,
    InvocationType: 'Event',
    Payload: Buffer.from(payload),
  }));

  if (res.StatusCode !== 202) {
    throw new Error(`Lambda invocation returned unexpected status ${res.StatusCode}`);
  }
}

async function main() {
  const [clientId, videoId] = process.argv.slice(2);
  if (!clientId || !videoId) {
    console.error('Usage: npm run reprocess-video -- <clientId> <videoId>');
    process.exit(1);
  }

  console.log(`\nReprocessing  client=${clientId}  video=${videoId}`);

  process.stdout.write('  Deleting DynamoDB chunk records ... ');
  const deleted = await deleteChunksDynamo(clientId, videoId);
  console.log(`${deleted} deleted`);

  if (deleted > 0) {
    process.stdout.write(`  Deleting ${deleted} Pinecone vectors ... `);
    await deleteVectorsPinecone(clientId, videoId, deleted);
    console.log('done');
  }

  process.stdout.write('  Invoking ttv-process-transcript (async) ... ');
  await invokeProcessTranscript(clientId, videoId);
  console.log('triggered');

  console.log('\nLambda is running in the background (~2 min). Verify when done:');
  console.log(`  aws dynamodb query --table-name ttv-chunks \\`);
  console.log(`    --key-condition-expression "client_id = :c AND begins_with(sk, :p)" \\`);
  console.log(`    --expression-attribute-values '{":c":{"S":"${clientId}"},":p":{"S":"VIDEO#${videoId}#CHUNK#"}}' \\`);
  console.log(`    --select COUNT --output json`);
}

main().catch(err => { console.error(err); process.exit(1); });
