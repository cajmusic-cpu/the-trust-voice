export interface ClientConfig {
  id: string;   // UUID — becomes S3 bucket suffix, Pinecone namespace, Cognito group name
  name: string; // Human-readable label for Cognito group description

  // Philanthropic Legacy module — a permanent, opt-in add-on (separate video,
  // kept out of the Q&A vault; see PhilanthropicLegacy.tsx). Independent of
  // subscription tier on purpose: tier/pricing eligibility is still being
  // finalized, and gating on entitlement rather than tier means that decision
  // never has to touch this file or the frontend again.
  hasPhilanthropicLegacyModule?: boolean;
  // Optional per-account co-branding line shown on the module page, e.g.
  // "Developed with Grant Philanthropic Advisors". Omit for accounts with no
  // referral-partner attribution.
  philanthropicLegacyAttribution?: string;
  // Optional per-account description shown below the title, for accounts
  // whose module was built with a specific referral partner's framework.
  // Omit to fall back to the generic description in PhilanthropicLegacy.tsx.
  philanthropicLegacyDescription?: string;
}

// Add one entry per grantor family before deploying.
// Generate a UUID for each new client: https://www.uuidgenerator.net/
// IDs are permanent — changing one after deploy orphans existing S3 data.
export const CLIENTS: ClientConfig[] = [
  { id: 'a32775e1-4edd-4740-bc22-84a453839487', name: 'Test Client' },
  { id: '5fbc7625-d566-4ec5-93f4-b82f52ad17bc', name: 'Robert Caldwell' },
  { id: 'c64e37b9-ca34-439b-8a03-c4de24b2b327', name: 'Wyatt Dixon' },
  {
    id: '594292a9-7704-4507-9f53-4de7eaf34657',
    name: 'Lisa Satterfield',
    hasPhilanthropicLegacyModule: true,
    philanthropicLegacyAttribution: 'Developed with Grant Philanthropic Advisors',
    philanthropicLegacyDescription:
      "Recorded privately for her family and designated trustee. Drawn from Grant Philanthropic " +
      "Advisors' family-giving framework — her values, motivations, and wishes for the causes she " +
      'cared about most.',
  },
];

// Removed 2026-09-14: 'Wyatt Dixon Demo' (a5be0dd6-14b9-4a47-a5bf-7440bdc7eb85)
// was a synthetic fixture — a copy of the real Wyatt Dixon's interview content
// used for sales demos — confirmed non-real and safe to remove (nothing else
// referenced it; its Cognito group had only the demo login as a member, now
// deleted). Its S3 buckets, DynamoDB rows, and Pinecone vectors were left in
// place, untouched — only the client-facing/access-control surface (this
// list + its Cognito group) was removed, so this is reversible if ever needed.
