export interface ClientConfig {
  id: string;   // UUID — becomes S3 bucket suffix, Pinecone namespace, Cognito group name
  name: string; // Human-readable label for Cognito group description
}

// Add one entry per grantor family before deploying.
// Generate a UUID for each new client: https://www.uuidgenerator.net/
// IDs are permanent — changing one after deploy orphans existing S3 data.
export const CLIENTS: ClientConfig[] = [
  { id: 'a32775e1-4edd-4740-bc22-84a453839487', name: 'Test Client' },
  // { id: '550e8400-e29b-41d4-a716-446655440001', name: 'Smith Family' },
  // { id: '550e8400-e29b-41d4-a716-446655440002', name: 'Johnson Family' },
];
