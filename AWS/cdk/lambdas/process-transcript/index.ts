import type { S3Event, S3EventRecord } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { parseTranscript } from './parseTranscript';
import { buildChunks } from './chunk';
import { embedTexts } from '../shared/embed';
import { upsertChunks, type ChunkVector } from '../shared/pinecone';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CHUNKS_TABLE = process.env['CHUNKS_TABLE']!;
const VIDEOS_TABLE = process.env['VIDEOS_TABLE']!;

// Bucket name format: ttv-{clientId}-transcripts
function parseClientId(bucketName: string): string {
  return bucketName.replace(/^ttv-/, '').replace(/-transcripts$/, '');
}

// Key format written by IngestLambda: {videoId}/ttv-{videoId}.json
function parseVideoId(key: string): string {
  return key.split('/')[0];
}

async function setStatus(
  clientId: string,
  videoId: string,
  status: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  const extraNames = extra ? Object.fromEntries(Object.keys(extra).map(k => [`#${k}`, k])) : {};
  const extraValues = extra ? Object.fromEntries(Object.entries(extra).map(([k, v]) => [`:${k}`, v])) : {};

  await ddb.send(
    new UpdateCommand({
      TableName: VIDEOS_TABLE,
      Key: { client_id: clientId, video_id: videoId },
      UpdateExpression: [
        'SET #status = :status, updated_at = :now',
        ...Object.keys(extra ?? {}).map(k => `#${k} = :${k}`),
      ].join(', '),
      ExpressionAttributeNames: { '#status': 'status', ...extraNames },
      ExpressionAttributeValues: { ':status': status, ':now': now, ...extraValues },
    }),
  );
}

async function processRecord(record: S3EventRecord): Promise<void> {
  const bucket = record.s3.bucket.name;
  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

  const clientId = parseClientId(bucket);
  const videoId = parseVideoId(key);

  console.log(`Processing transcript for client=${clientId} video=${videoId}`);

  // ── 1. Download transcript JSON from S3 ─────────────────────────────────
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await res.Body?.transformToString('utf-8');
  if (!body) throw new Error(`Empty transcript body at s3://${bucket}/${key}`);

  // ── 2. Parse + chunk ─────────────────────────────────────────────────────
  const words = parseTranscript(JSON.parse(body));
  const chunks = buildChunks(words);

  if (chunks.length === 0) {
    console.warn(`No chunks produced for video ${videoId} — transcript may be empty`);
    await setStatus(clientId, videoId, 'ERROR', { error: 'No transcript content found' });
    return;
  }

  await setStatus(clientId, videoId, 'PROCESSING');

  // ── 2b. Determine subject speaker and per-chunk is_subject flag ───────────
  // Subject = the speaker with the most total words across all chunks.
  // is_subject = true when the subject's words are >= 30% of the chunk's words.
  // This keeps chunks that mix an interviewer question with the subject's answer
  // (the question provides context) while excluding chunks that are predominantly
  // interviewer-only speech.
  const globalSpeakerCounts: Record<string, number> = {};
  for (const chunk of chunks) {
    for (const [spk, count] of Object.entries(chunk.speakerCounts)) {
      globalSpeakerCounts[spk] = (globalSpeakerCounts[spk] ?? 0) + count;
    }
  }
  const subjectSpeaker = Object.entries(globalSpeakerCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

  const isSubjectChunk = (chunk: (typeof chunks)[number]): boolean => {
    const total = Object.values(chunk.speakerCounts).reduce((s, n) => s + n, 0);
    if (total === 0) return true;
    return (chunk.speakerCounts[subjectSpeaker] ?? 0) / total >= 0.30;
  };

  // Precompute once — isSubjectChunk is called in steps 3, 4, and 5.
  const isSubject = chunks.map(isSubjectChunk);

  // ── 3. Embed all chunks via Bedrock (Titan Embed Text v2, 1024 dims) ───────
  // For subject chunks that are immediately preceded by a non-subject turn,
  // prepend the interviewer question text to the embedding input. This gives the
  // vector awareness of the surrounding question so that a query like "message to
  // grandchildren" can match even when the subject's answer never uses those words.
  // The stored text and sentences_json remain subject-only — only the vector differs.
  const embedInputs = chunks.map((chunk, i) => {
    if (!isSubject[i]) return chunk.text;
    const prev = i > 0 ? chunks[i - 1] : null;
    if (prev && !isSubject[i - 1]) return `${prev.text} ${chunk.text}`;
    return chunk.text;
  });
  const embeddings = await embedTexts(embedInputs);

  // ── 4. Write chunk records to DynamoDB (concurrent) ──────────────────────
  // Sort key format: VIDEO#<videoId>#CHUNK#<zero-padded index>
  // Zero-padding to 6 digits lets DynamoDB range queries return chunks in order.
  const now = new Date().toISOString();
  await Promise.all(
    chunks.map((chunk, i) =>
      ddb.send(
        new PutCommand({
          TableName: CHUNKS_TABLE,
          Item: {
            client_id: clientId,
            sk: `VIDEO#${videoId}#CHUNK#${String(i).padStart(6, '0')}`,
            video_id: videoId,
            chunk_index: chunk.chunkIndex,
            start_time: chunk.startTime,
            end_time: chunk.endTime,
            speaker: chunk.speaker,
            is_subject: isSubject[i],
            text: chunk.text,
            pinecone_id: `${videoId}/${chunk.chunkIndex}`,
            created_at: now,
          },
        }),
      ),
    ),
  );

  // ── 5. Upsert vectors to Pinecone ─────────────────────────────────────────
  // namespace = clientId keeps each client's data physically separate in Pinecone.
  const vectors: ChunkVector[] = chunks.map((chunk, i) => ({
    id: `${videoId}/${chunk.chunkIndex}`,
    values: embeddings[i],
    metadata: {
      video_id: videoId,
      chunk_index: chunk.chunkIndex,
      start_time: chunk.startTime,
      end_time: chunk.endTime,
      speaker: chunk.speaker,
      is_subject: isSubject[i],
      text: chunk.text,
      sentences_json: JSON.stringify(chunk.sentences),
    },
  }));

  await upsertChunks(clientId, vectors);

  // ── 6. Mark video as ready ────────────────────────────────────────────────
  await setStatus(clientId, videoId, 'READY', {
    chunk_count: chunks.length,
    subject_speaker: subjectSpeaker,
  });

  console.log(`Finished: ${chunks.length} chunks indexed for video ${videoId}`);
}

// eslint-disable-next-line trust-voice/require-isolation-wrapper -- S3-triggered, no JWT context
export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      console.error('Failed to process transcript record:', JSON.stringify(record.s3), err);
    }
  }
};
