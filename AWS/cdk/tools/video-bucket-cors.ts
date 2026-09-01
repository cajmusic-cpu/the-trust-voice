import type { CORSRule } from '@aws-sdk/client-s3';

// CORS configuration applied to every ttv-{clientId}-videos bucket.
//
//  - PUT      : videographers upload originals directly to S3 from the upload
//               portal (upload.thetrustvoice.com).
//  - GET/HEAD : trustees stream presigned-URL video clips from the web portal
//               (portal.thetrustvoice.com). Range requests need the response
//               headers exposed so the <video> element can seek. Playback works
//               without this today only because the player sets no crossOrigin;
//               this hardens the path and unblocks any future crossOrigin use
//               (captions, canvas frame capture, fetch()-based instrumentation).
//
// Shared by tools/add-client.ts (new clients) and tools/backfill-video-cors.ts
// (existing clients, which CDK and add-client will not revisit).
export const VIDEO_BUCKET_CORS_RULES: CORSRule[] = [
  {
    AllowedMethods: ['PUT'],
    AllowedOrigins: ['https://upload.thetrustvoice.com'],
    AllowedHeaders: ['*'],
    MaxAgeSeconds: 3000,
  },
  {
    AllowedMethods: ['GET', 'HEAD'],
    AllowedOrigins: [
      'https://portal.thetrustvoice.com',
      'http://localhost:5173',
    ],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges', 'ETag'],
    MaxAgeSeconds: 3000,
  },
];
