// Principle-bridge fallback retrieval — theme taxonomy.
//
// Drafted from Interview Curriculum v5.0 ("claude-code-instructions-principle-bridge-retrieval-v2.md").
// This is a first pass — Deni/Scott should review before it's used to tag
// content trustees will actually see (see tools/backfill-theme-tags.ts).
//
// IMPORTANT: `key`, `section`, and `label` are the ONLY fields used to build
// the theme-classification prompts in shared/themeClassifier.ts. `questionRefs`
// is carried purely for traceability in the review CSV and plays no role in
// classification. This is deliberate: the curriculum is still being edited, and
// a wording-only change to a question must not require re-tagging anything —
// only a structural change (new/removed/redefined theme) touches this file.
//
// `scenarioSpecific: true` marks entries the source doc flags as likely
// direct-match candidates rather than fallback material (Section 6 Q3/Q8, and
// most of Section 7) — carried as metadata for the review CSV, not used to
// change retrieval behavior automatically.

export interface ThemeDef {
  key: string;
  section: string;
  label: string;
  questionRefs: string; // traceability only — not used in classification prompts
  scenarioSpecific?: boolean;
}

export const THEMES: ThemeDef[] = [
  // ── Section 2 — Wealth Philosophy ─────────────────────────────────────────
  { key: 'wealth_purpose', section: 'Wealth Philosophy', label: 'What wealth is ultimately for', questionRefs: 'Section 2 Q1' },
  { key: 'wealth_harm_threshold', section: 'Wealth Philosophy', label: 'When money does more harm than good', questionRefs: 'Section 2 Q2' },
  { key: 'reasonable_vs_extravagant', section: 'Wealth Philosophy', label: 'Reasonable spending vs. extravagance', questionRefs: 'Section 2 Q3' },
  { key: 'financial_responsibility', section: 'Wealth Philosophy', label: 'What financial responsibility looks like', questionRefs: 'Section 2 Q4' },
  { key: 'helping_vs_enabling', section: 'Wealth Philosophy', label: 'Helping a beneficiary vs. enabling them', questionRefs: 'Section 2 Q5' },
  { key: 'financial_independence', section: 'Wealth Philosophy', label: 'Encouraging financial independence', questionRefs: 'Section 2 Q6' },
  { key: 'gratitude_in_receiving', section: 'Wealth Philosophy', label: 'Gratitude and humility in receiving support', questionRefs: 'Section 2 Q7' },
  { key: 'fairness_vs_equality', section: 'Wealth Philosophy', label: 'Fairness vs. strict equality among beneficiaries', questionRefs: 'Section 2 Q8' },
  { key: 'responsibility_of_wealth', section: 'Wealth Philosophy', label: 'The responsibility that comes with wealth', questionRefs: 'Section 2 Q9' },
  { key: 'generosity_and_legacy', section: 'Wealth Philosophy', label: 'Generosity as part of the legacy', questionRefs: 'Section 2 Q10' },
  { key: 'financial_lessons_for_future', section: 'Wealth Philosophy', label: 'Financial lessons for future generations', questionRefs: 'Section 2 Q11' },

  // ── Section 3 — Family ────────────────────────────────────────────────────
  { key: 'family_traditions', section: 'Family', label: 'Family traditions worth preserving', questionRefs: 'Section 3 Q1, Q6' },
  { key: 'heirlooms_and_property', section: 'Family', label: 'Heirlooms, property, and how they should pass down', questionRefs: 'Section 3 Q2' },
  { key: 'core_family_values', section: 'Family', label: 'The core values that define this family', questionRefs: 'Section 3 Q3, Q4' },
  { key: 'forgiveness', section: 'Family', label: 'Forgiveness and repairing family rifts', questionRefs: 'Section 3 Q5' },

  // ── Section 4 — Education & Growth ────────────────────────────────────────
  { key: 'education_paths', section: 'Education & Growth', label: 'Supporting different education paths', questionRefs: 'Section 4 Q1, Q2' },
  { key: 'personal_growth_investment', section: 'Education & Growth', label: 'Investing in a beneficiary’s personal growth', questionRefs: 'Section 4 Q3' },
  { key: 'defining_success', section: 'Education & Growth', label: 'How success should be defined', questionRefs: 'Section 4 Q4' },
  { key: 'risk_and_ambition', section: 'Education & Growth', label: 'Supporting ambitious or risky pursuits', questionRefs: 'Section 4 Q5' },
  { key: 'early_adulthood_guidance', section: 'Education & Growth', label: 'Guidance for the early-adulthood years', questionRefs: 'Section 4 Q6' },

  // ── Section 5 — Health & Life Challenges ──────────────────────────────────
  { key: 'asking_for_help', section: 'Health & Life Challenges', label: 'The importance of asking for help', questionRefs: 'Section 5 Q1' },
  { key: 'courage_and_hardship', section: 'Health & Life Challenges', label: 'Courage in the face of hardship', questionRefs: 'Section 5 Q2' },
  { key: 'response_to_mistakes', section: 'Health & Life Challenges', label: 'How mistakes should be met', questionRefs: 'Section 5 Q3' },
  { key: 'compassion_in_struggle', section: 'Health & Life Challenges', label: 'Compassion for a beneficiary who is struggling', questionRefs: 'Section 5 Q4' },
  { key: 'hope_in_difficulty', section: 'Health & Life Challenges', label: 'Holding on to hope during difficult times', questionRefs: 'Section 5 Q5' },

  // ── Section 6 — Work & Stewardship ────────────────────────────────────────
  { key: 'meaningful_work', section: 'Work & Stewardship', label: 'What makes work meaningful', questionRefs: 'Section 6 Q1, Q2' },
  { key: 'investment_property_requests', section: 'Work & Stewardship', label: 'Requests to fund a specific investment or property', questionRefs: 'Section 6 Q3', scenarioSpecific: true },
  { key: 'trustworthiness', section: 'Work & Stewardship', label: 'What trustworthiness looks like in practice', questionRefs: 'Section 6 Q4, Q5' },
  { key: 'personal_accountability', section: 'Work & Stewardship', label: 'Personal accountability and ownership', questionRefs: 'Section 6 Q6, Q7' },
  { key: 'discretionary_purchase_scrutiny', section: 'Work & Stewardship', label: 'Scrutinizing discretionary purchases (vehicles, boats, cosmetic procedures)', questionRefs: 'Section 6 Q8', scenarioSpecific: true },
  { key: 'discipline_and_contentment', section: 'Work & Stewardship', label: 'Discipline and contentment with what one has', questionRefs: 'Section 6 Q9, Q10' },
  { key: 'financial_habits', section: 'Work & Stewardship', label: 'Good financial habits worth instilling', questionRefs: 'Section 6 Q11, Q12' },

  // ── Section 7 — Trustee Decision Principles ───────────────────────────────
  { key: 'discretion_guiding_principle', section: 'Trustee Decision Principles', label: 'The guiding principle behind trustee discretion', questionRefs: 'Section 7 Q1, Q2', scenarioSpecific: true },
  { key: 'adapting_to_change', section: 'Trustee Decision Principles', label: 'Adapting decisions as circumstances change', questionRefs: 'Section 7 Q3', scenarioSpecific: true },
  { key: 'judgment_qualities', section: 'Trustee Decision Principles', label: 'What good trustee judgment looks like', questionRefs: 'Section 7 Q4', scenarioSpecific: true },
  { key: 'prohibited_uses', section: 'Trustee Decision Principles', label: 'Uses of trust funds that should never be allowed', questionRefs: 'Section 7 Q5', scenarioSpecific: true },
  { key: 'values_above_money', section: 'Trustee Decision Principles', label: 'Putting values above the money itself', questionRefs: 'Section 7 Q6', scenarioSpecific: true },
  { key: 'compassion_vs_responsibility', section: 'Trustee Decision Principles', label: 'Balancing compassion with responsibility', questionRefs: 'Section 7 Q7', scenarioSpecific: true },
  { key: 'flexibility_vs_consistency', section: 'Trustee Decision Principles', label: 'Flexibility vs. staying consistent across beneficiaries', questionRefs: 'Section 7 Q8', scenarioSpecific: true },
  { key: 'effort_and_support', section: 'Trustee Decision Principles', label: 'Matching support to a beneficiary’s own effort', questionRefs: 'Section 7 Q9', scenarioSpecific: true },
  { key: 'fairness_different_needs', section: 'Trustee Decision Principles', label: 'Fairness when beneficiaries have different needs', questionRefs: 'Section 7 Q10', scenarioSpecific: true },
  { key: 'new_opportunities_and_innovation', section: 'Trustee Decision Principles', label: 'Supporting new opportunities and unforeseen ventures', questionRefs: 'Section 7 Q11, Q12', scenarioSpecific: true },
  { key: 'personal_growth_requests', section: 'Trustee Decision Principles', label: 'Requests tied to personal growth or self-improvement', questionRefs: 'Section 7 Q13', scenarioSpecific: true },
  { key: 'character_in_decisions', section: 'Trustee Decision Principles', label: 'Weighing a beneficiary’s character in a decision', questionRefs: 'Section 7 Q14', scenarioSpecific: true },
  { key: 'temporary_vs_chronic_hardship', section: 'Trustee Decision Principles', label: 'Temporary setback vs. a chronic pattern', questionRefs: 'Section 7 Q15', scenarioSpecific: true },
  { key: 'disappointing_a_beneficiary', section: 'Trustee Decision Principles', label: 'When the right decision will disappoint a beneficiary', questionRefs: 'Section 7 Q16', scenarioSpecific: true },
  { key: 'explaining_different_outcomes', section: 'Trustee Decision Principles', label: 'Explaining why beneficiaries received different outcomes', questionRefs: 'Section 7 Q17', scenarioSpecific: true },
  { key: 'unprecedented_situations', section: 'Trustee Decision Principles', label: 'Situations the trust document never anticipated', questionRefs: 'Section 7 Q18', scenarioSpecific: true },
  { key: 'preserving_wealth_vs_people', section: 'Trustee Decision Principles', label: 'Preserving the wealth vs. preserving the people', questionRefs: 'Section 7 Q19', scenarioSpecific: true },
  { key: 'legacy_intent', section: 'Trustee Decision Principles', label: 'The deeper intent behind the legacy, beyond the document', questionRefs: 'Section 7 Q20', scenarioSpecific: true },
  { key: 'business_succession', section: 'Trustee Decision Principles', label: 'How a family business or venture should be handled', questionRefs: 'Section 7 Q21', scenarioSpecific: true },
  { key: 'reliance_on_outside_advice', section: 'Trustee Decision Principles', label: 'When the trustee should lean on outside advisors', questionRefs: 'Section 7 Q22', scenarioSpecific: true },
  { key: 'shared_sacrifice', section: 'Trustee Decision Principles', label: 'Shared sacrifice among beneficiaries', questionRefs: 'Section 7 Q23', scenarioSpecific: true },
  { key: 'single_most_important_principle', section: 'Trustee Decision Principles', label: 'The single most important principle to hold onto', questionRefs: 'Section 7 Q24', scenarioSpecific: true },

  // ── Section 8 — A Voice for the Future ────────────────────────────────────
  { key: 'messages_to_future_generations', section: 'A Voice for the Future', label: 'A direct message to future generations', questionRefs: 'Section 8 (all)' },
];

export function findTheme(key: string): ThemeDef | undefined {
  return THEMES.find(t => t.key === key);
}

// Rendered once and reused in every classification prompt — key + section +
// label only, per the file-header note above.
export function themesPromptBlock(): string {
  return THEMES.map(t => `${t.key} — [${t.section}] ${t.label}`).join('\n');
}
