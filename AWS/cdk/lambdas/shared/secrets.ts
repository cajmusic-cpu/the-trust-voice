import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({});

// Module-level cache: secrets are fetched once per cold start, never per invocation.
const cache = new Map<string, string>();

export async function getSecret(secretId: string): Promise<string> {
  const cached = cache.get(secretId);
  if (cached !== undefined) return cached;

  const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!res.SecretString) throw new Error(`Secret ${secretId} has no string value`);

  cache.set(secretId, res.SecretString);
  return res.SecretString;
}

export async function getSecretJson<T>(secretId: string): Promise<T> {
  const raw = await getSecret(secretId);
  return JSON.parse(raw) as T;
}
