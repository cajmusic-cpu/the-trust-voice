import { Pinecone, type Index, type RecordMetadata } from '@pinecone-database/pinecone';
import { getSecretJson } from './secrets';

interface PineconeSecrets {
  api_key: string;
}

// Extends RecordMetadata so ChunkVector satisfies PineconeRecord<RecordMetadata>
// without a cast. All field types (string | number) are valid RecordMetadataValues.
export interface ChunkMetadata extends RecordMetadata {
  video_id: string;
  chunk_index: number;
  start_time: number;  // seconds from video start
  end_time: number;
  speaker: string;
  is_subject: boolean; // false when subject words < 30% of chunk — filters out interviewer-only chunks
  text: string;        // the transcript excerpt shown as a citation quote
  sentences_json: string;  // JSON-encoded [{startTime, text}] for sub-chunk seeking
  themes: string[];    // principle-bridge theme keys (shared/themes.ts), [] when
                        // classification found no confident match. Required in
                        // this type for new writes, but the Pinecone SDK's
                        // metadata-value type has no `undefined`, so treat it as
                        // optional at read time (`metadata.themes ?? []`) —
                        // chunks ingested before tagging existed won't have it.
  block_themes_json: string;  // JSON-encoded BlockThemes[] (shared/blockThemeClassifier.ts),
                        // only non-empty for a chunk with more than one subject speech
                        // block — see that file for why block-level tags exist at all.
                        // '' (not omitted — same RecordMetadataValue constraint as
                        // `themes` above) for every chunk with 0 or 1 block, which is
                        // most of them; read defensively as `metadata.block_themes_json || null`.
}

export interface ChunkVector {
  id: string;          // "<videoId>/<chunkIndex>" — stable, idempotent upsert key
  values: number[];    // 1024-dimension Cohere embedding
  metadata: ChunkMetadata;
}

export interface ChunkMatch {
  id: string;
  score: number;
  metadata: ChunkMetadata;
  values: number[];  // embedding vector — used for pairwise similarity deduplication
}

// Cached at module level — one Pinecone Index client per cold start.
let cachedIndex: Index | null = null;

async function getIndex(): Promise<Index> {
  if (cachedIndex) return cachedIndex;

  const { api_key } = await getSecretJson<PineconeSecrets>(
    process.env['PINECONE_SECRET_ARN']!,
  );

  const pc = new Pinecone({ apiKey: api_key });

  // Providing the index host avoids a describe_index round-trip on every cold start.
  cachedIndex = pc.index(
    process.env['PINECONE_INDEX_NAME']!,
    process.env['PINECONE_INDEX_HOST']!,
  );

  return cachedIndex;
}

// Upserts chunk vectors into the client's namespace in batches of 50.
// Namespace = clientId enforces data isolation at the vector DB level.
export async function upsertChunks(namespace: string, vectors: ChunkVector[]): Promise<void> {
  if (vectors.length === 0) return;

  const index = await getIndex();
  const ns = index.namespace(namespace);
  const BATCH_SIZE = 50;

  for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
    const batch = vectors.slice(i, i + BATCH_SIZE);
    await ns.upsert(batch);
  }
}

// Fetches stored vectors by ID from the client's namespace.
// Returns a map of id → values for any IDs that exist in Pinecone.
// Used to score adjacent chunks against the query embedding without a full search.
export async function fetchVectors(
  namespace: string,
  ids: string[],
): Promise<Record<string, number[]>> {
  if (ids.length === 0) return {};
  const index = await getIndex();
  const ns = index.namespace(namespace);
  const result = await ns.fetch(ids);
  const out: Record<string, number[]> = {};
  for (const [id, record] of Object.entries(result.records ?? {})) {
    const vals = record.values;
    if (vals && vals.length > 0) out[id] = vals;
  }
  return out;
}

// Metadata-only update — does NOT touch the stored vector values. Used by the
// theme backfill (tools/backfill-theme-tags.ts --apply) to reconcile tags
// without re-embedding or re-upserting anything. blockThemesJson is passed only
// for a multi-block chunk (shared/blockThemeClassifier.ts); omitted for every
// other chunk, so update() (a Partial<ChunkMetadata> per the Pinecone SDK's own
// update.d.ts) never has to satisfy the full metadata shape here.
export async function updateChunkThemes(
  namespace: string,
  id: string,
  themes: string[],
  blockThemesJson?: string,
): Promise<void> {
  const index = await getIndex();
  const ns = index.namespace(namespace);
  await ns.update({
    id,
    metadata: blockThemesJson !== undefined ? { themes, block_themes_json: blockThemesJson } : { themes },
  });
}

// Searches the given namespace (= clientId) for the top-k most similar chunks.
// Pass filter to narrow results by Pinecone metadata (e.g. { is_subject: true }).
export async function searchChunks(
  namespace: string,
  embedding: number[],
  topK = 3,
  filter?: Record<string, unknown>,
): Promise<ChunkMatch[]> {
  const index = await getIndex();
  const ns = index.namespace(namespace);

  const res = await ns.query({
    vector: embedding,
    topK,
    includeMetadata: true,
    includeValues: true,
    ...(filter ? { filter } : {}),
  });

  return (res.matches ?? [])
    .filter((m): m is typeof m & { metadata: Record<string, unknown> } => !!m.metadata)
    .map(m => ({
      id: m.id,
      score: m.score ?? 0,
      metadata: m.metadata as unknown as ChunkMetadata,
      values: m.values ?? [],
    }));
}
