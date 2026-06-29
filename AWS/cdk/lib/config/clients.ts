export interface ClientConfig {
  id: string;   // UUID — becomes S3 bucket suffix, Pinecone namespace, Cognito group name
  name: string; // Human-readable label for Cognito group description
}

// Add one entry per grantor family before deploying.
// Generate a UUID for each new client: https://www.uuidgenerator.net/
// IDs are permanent — changing one after deploy orphans existing S3 data.
export const CLIENTS: ClientConfig[] = [
  { id: 'a32775e1-4edd-4740-bc22-84a453839487', name: 'Test Client' },
  { id: '5fbc7625-d566-4ec5-93f4-b82f52ad17bc', name: 'Robert Caldwell' },
  { id: 'a5be0dd6-14b9-4a47-a5bf-7440bdc7eb85', name: 'Wyatt Dixon Demo' },
  { id: 'c64e37b9-ca34-439b-8a03-c4de24b2b327', name: 'Wyatt Dixon' },
  { id: '594292a9-7704-4507-9f53-4de7eaf34657', name: 'Lisa Satterfield' },
];
