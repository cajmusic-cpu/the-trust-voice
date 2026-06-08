import * as path from 'path';
import type { S3Event, S3EventRecord } from 'aws-lambda';
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  ConflictException,
} from '@aws-sdk/client-transcribe';
import {
  MediaConvertClient,
  CreateJobCommand,
  DescribeEndpointsCommand,
} from '@aws-sdk/client-mediaconvert';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const transcribe = new TranscribeClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const VIDEOS_TABLE = process.env['VIDEOS_TABLE']!;
const MEDIACONVERT_ROLE_ARN = process.env['MEDIACONVERT_ROLE_ARN']!;

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.flac'];

// Cached after first cold-start call — MediaConvert requires account-specific endpoint.
let mediaConvertEndpoint: string | undefined;

async function getMediaConvertClient(): Promise<MediaConvertClient> {
  if (!mediaConvertEndpoint) {
    const probe = new MediaConvertClient({});
    const { Endpoints } = await probe.send(new DescribeEndpointsCommand({ MaxResults: 1 }));
    mediaConvertEndpoint = Endpoints?.[0]?.Url;
    if (!mediaConvertEndpoint) throw new Error('No MediaConvert endpoint returned');
  }
  return new MediaConvertClient({ endpoint: mediaConvertEndpoint });
}

// Bucket name format: ttv-{clientId}-videos
function parseClientId(bucketName: string): string {
  return bucketName.replace(/^ttv-/, '').replace(/-videos$/, '');
}

// Key format: {videoId}/{filename}
function parseVideoId(key: string): string | null {
  const slash = key.indexOf('/');
  if (slash <= 0) return null;
  return key.slice(0, slash);
}

// Phase 1: original video uploaded.
// Starts a single MediaConvert job with two output groups:
//   1. Audio MP3  → s3://{bucket}/{videoId}/audio.mp3   (re-triggers Lambda → Transcribe)
//   2. Optimized MP4 → s3://{bucket}/{videoId}/optimized.mp4  (re-triggers Lambda → updateOptimizedKey)
async function startMediaConvertJob(
  bucket: string,
  key: string,
  clientId: string,
  videoId: string,
): Promise<void> {
  const now = new Date().toISOString();

  try {
    await ddb.send(
      new PutCommand({
        TableName: VIDEOS_TABLE,
        Item: {
          client_id: clientId,
          video_id: videoId,
          status: 'EXTRACTING_AUDIO',
          s3_key: key,
          video_bucket: bucket,
          created_at: now,
          updated_at: now,
        },
        ConditionExpression: 'attribute_not_exists(video_id)',
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      console.log(`Video ${videoId} already registered — duplicate S3 event, skipping`);
      return;
    }
    throw err;
  }

  const mc = await getMediaConvertClient();

  await mc.send(
    new CreateJobCommand({
      Role: MEDIACONVERT_ROLE_ARN,
      Settings: {
        Inputs: [
          {
            FileInput: `s3://${bucket}/${key}`,
            AudioSelectors: { 'Audio Selector 1': { DefaultSelection: 'DEFAULT' } },
            VideoSelector: {},
            TimecodeSource: 'ZEROBASED',
          },
        ],
        OutputGroups: [
          // ── Output 1: Audio MP3 for Transcribe ───────────────────────────────
          {
            Name: 'AudioExtract',
            OutputGroupSettings: {
              Type: 'FILE_GROUP_SETTINGS',
              FileGroupSettings: {
                Destination: `s3://${bucket}/${videoId}/audio`,
              },
            },
            Outputs: [
              {
                ContainerSettings: { Container: 'RAW' },
                AudioDescriptions: [
                  {
                    CodecSettings: {
                      Codec: 'MP3',
                      Mp3Settings: {
                        Bitrate: 64000,
                        Channels: 1,
                        SampleRate: 22050,
                        RateControlMode: 'CBR',
                      },
                    },
                  },
                ],
              },
            ],
          },
          // ── Output 2: Web-optimized MP4 (moov atom at front) ────────────────
          //
          // MoovPlacement: PROGRESSIVE_DOWNLOAD moves the moov atom to the
          // beginning of the file (equivalent to ffmpeg -movflags faststart).
          // This lets browsers start playback and seek without downloading the
          // entire file first — critical for large recordings (2+ GB).
          {
            Name: 'OptimizedVideo',
            OutputGroupSettings: {
              Type: 'FILE_GROUP_SETTINGS',
              FileGroupSettings: {
                Destination: `s3://${bucket}/${videoId}/optimized`,
              },
            },
            Outputs: [
              {
                ContainerSettings: {
                  Container: 'MP4',
                  Mp4Settings: {
                    MoovPlacement: 'PROGRESSIVE_DOWNLOAD',
                    CslgAtom: 'INCLUDE',
                    FreeSpaceBox: 'EXCLUDE',
                    AudioDuration: 'DEFAULT_CODEC_DURATION',
                  },
                },
                VideoDescription: {
                  CodecSettings: {
                    Codec: 'H_264',
                    H264Settings: {
                      RateControlMode: 'QVBR',
                      QvbrSettings: { QvbrQualityLevel: 8 },
                      MaxBitrate: 8000000,
                      SceneChangeDetect: 'TRANSITION_DETECTION',
                      QualityTuningLevel: 'SINGLE_PASS_HQ',
                    },
                  },
                },
                AudioDescriptions: [
                  {
                    CodecSettings: {
                      Codec: 'AAC',
                      AacSettings: {
                        Bitrate: 128000,
                        CodingMode: 'CODING_MODE_2_0',
                        SampleRate: 48000,
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    }),
  );

  console.log(`Started MediaConvert job for ${videoId}: audio extract + web-optimize`);
}

// Phase 2a: MediaConvert wrote audio.mp3 → start Transcribe.
async function startTranscription(
  bucket: string,
  audioKey: string,
  clientId: string,
  videoId: string,
): Promise<void> {
  const transcriptBucket = `ttv-${clientId}-transcripts`;
  const jobName = `ttv-${videoId}`;

  await ddb.send(
    new UpdateCommand({
      TableName: VIDEOS_TABLE,
      Key: { client_id: clientId, video_id: videoId },
      UpdateExpression: 'SET #status = :status, audio_key = :audioKey, updated_at = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'TRANSCRIBING',
        ':audioKey': audioKey,
        ':now': new Date().toISOString(),
      },
    }),
  );

  try {
    await transcribe.send(
      new StartTranscriptionJobCommand({
        TranscriptionJobName: jobName,
        Media: { MediaFileUri: `s3://${bucket}/${audioKey}` },
        OutputBucketName: transcriptBucket,
        OutputKey: `${videoId}/`,
        LanguageCode: 'en-US',
        Settings: {
          ShowSpeakerLabels: true,
          MaxSpeakerLabels: 10,
          ShowAlternatives: false,
        },
      }),
    );
  } catch (err: unknown) {
    if (err instanceof ConflictException) {
      console.log(`Transcribe job ${jobName} already exists, skipping`);
      return;
    }
    await ddb.send(
      new UpdateCommand({
        TableName: VIDEOS_TABLE,
        Key: { client_id: clientId, video_id: videoId },
        UpdateExpression: 'SET #status = :status, #error = :error, updated_at = :now',
        ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
        ExpressionAttributeValues: {
          ':status': 'ERROR',
          ':error': (err as Error).message,
          ':now': new Date().toISOString(),
        },
      }),
    );
    throw err;
  }

  console.log(`Started Transcribe job ${jobName} for video ${videoId}`);
}

// Phase 2b: MediaConvert wrote optimized.mp4 → update DynamoDB so the portal
// serves the web-optimized version instead of the original upload.
async function updateOptimizedKey(
  clientId: string,
  videoId: string,
  optimizedKey: string,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: VIDEOS_TABLE,
      Key: { client_id: clientId, video_id: videoId },
      UpdateExpression: 'SET s3_key = :key, updated_at = :now',
      ExpressionAttributeValues: {
        ':key': optimizedKey,
        ':now': new Date().toISOString(),
      },
    }),
  );
  console.log(`Updated s3_key to optimized version for video ${videoId}: ${optimizedKey}`);
}

async function processRecord(record: S3EventRecord): Promise<void> {
  const bucket = record.s3.bucket.name;
  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

  if (key.endsWith('/') || key.includes('/.')) return;

  const clientId = parseClientId(bucket);
  const videoId = parseVideoId(key);

  if (!videoId) {
    console.warn(`Skipping key with no videoId prefix: ${key}`);
    return;
  }

  const filename = path.basename(key);
  const ext = path.extname(filename).toLowerCase();

  if (filename === 'optimized.mp4') {
    // MediaConvert finished the web-optimized video — point DynamoDB at it.
    await updateOptimizedKey(clientId, videoId, key);
  } else if (AUDIO_EXTENSIONS.includes(ext)) {
    // MediaConvert finished audio extraction — start Transcribe.
    await startTranscription(bucket, key, clientId, videoId);
  } else {
    // Original video upload — kick off both MediaConvert jobs.
    await startMediaConvertJob(bucket, key, clientId, videoId);
  }
}

// eslint-disable-next-line trust-voice/require-isolation-wrapper -- S3-triggered, no JWT context
export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      console.error('Failed to process S3 record:', JSON.stringify(record.s3), err);
    }
  }
};
