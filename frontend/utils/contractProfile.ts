/**
 * Structured commercial profile for printing contracts.
 *
 * The contract form historically exposed a single free-text "Terms" box
 * (placeholder: "Printing specifications, pricing rules, delivery terms…"),
 * so the four blocks that matter on a real printing agreement had nowhere
 * to live as data:
 *
 * - Printing specification (paper, colour, sides, pages, copies, finishing…)
 * - Pricing rules (how the price is derived, not just the headline total)
 * - Delivery terms (how / where / when the printed work is delivered)
 * - Candidature (expected candidate volume + sittings for exam work)
 *
 * Storage: everything lives inside `AssessmentContract.data` (JSONB, synced
 * through the existing envelope like any other contract field) so no DB
 * migration is required. Flat legacy keys (`total_candidature`,
 * `assessment_spec`, `charge_per_candidate`, `assessment_sittings`) are kept
 * in sync because the schedule document + its test read those keys.
 */

export interface ContractPrintSpec {
  paperSize?: string;
  paperType?: string;
  paperWeight?: string;
  colorMode?: string;
  sides?: string;
  pagesPerCopy?: string;
  copies?: string;
  orientation?: string;
  finishing?: string;
  packaging?: string;
  specNotes?: string;
}

export interface ContractPricingRules {
  model?: string;
  chargePerCandidate?: number;
  discount?: string;
  urgentFee?: string;
  taxHandling?: string;
  rulesNotes?: string;
}

export interface ContractDeliveryTerms {
  method?: string;
  timeline?: string;
  address?: string;
  packaging?: string;
  deliveryNotes?: string;
}

export interface ContractCandidature {
  totalCandidature?: number;
  sittings?: string;
  spec?: string;
}

export interface ContractProfile {
  printSpec: ContractPrintSpec;
  pricingRules: ContractPricingRules;
  delivery: ContractDeliveryTerms;
  candidature: ContractCandidature;
}

export const emptyContractProfile = (): ContractProfile => ({
  printSpec: {
    paperSize: '',
    paperType: '',
    paperWeight: '',
    colorMode: '',
    sides: '',
    pagesPerCopy: '',
    copies: '',
    orientation: '',
    finishing: '',
    packaging: '',
    specNotes: '',
  },
  pricingRules: {
    model: '',
    chargePerCandidate: undefined,
    discount: '',
    urgentFee: '',
    taxHandling: '',
    rulesNotes: '',
  },
  delivery: {
    method: '',
    timeline: '',
    address: '',
    packaging: '',
    deliveryNotes: '',
  },
  candidature: {
    totalCandidature: undefined,
    sittings: '',
    spec: '',
  },
});

const numOrUndefined = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

/** Read the structured profile out of a contract's `data` bag (tolerates legacy rows). */
export const readContractProfile = (data: unknown): ContractProfile => {
  const d = (data || {}) as Record<string, any>;
  const nested = (d.contract_profile || {}) as Record<string, any>;
  const printSpec = (nested.print_spec || d.print_spec || {}) as Record<string, any>;
  const pricing = (nested.pricing_rules || d.pricing_rules || {}) as Record<string, any>;
  const delivery = (nested.delivery_terms || d.delivery_terms || {}) as Record<string, any>;
  const cand = (nested.candidature || d.candidature || {}) as Record<string, any>;
  const profile = emptyContractProfile();
  profile.printSpec = {
    ...profile.printSpec,
    paperSize: str(printSpec.paper_size ?? printSpec.paperSize ?? ''),
    paperType: str(printSpec.paper_type ?? printSpec.paperType ?? ''),
    paperWeight: str(printSpec.paper_weight ?? printSpec.paperWeight ?? ''),
    colorMode: str(printSpec.color_mode ?? printSpec.colorMode ?? ''),
    sides: str(printSpec.sides ?? ''),
    pagesPerCopy: str(printSpec.pages_per_copy ?? printSpec.pagesPerCopy ?? ''),
    copies: str(printSpec.copies ?? ''),
    orientation: str(printSpec.orientation ?? ''),
    finishing: str(printSpec.finishing ?? ''),
    packaging: str(printSpec.packaging ?? ''),
    specNotes: str(printSpec.notes ?? printSpec.spec_notes ?? ''),
  };
  profile.pricingRules = {
    ...profile.pricingRules,
    model: str(pricing.model ?? pricing.pricing_model ?? ''),
    chargePerCandidate: numOrUndefined(
      pricing.charge_per_candidate ?? pricing.chargePerCandidate ?? d.charge_per_candidate,
    ),
    discount: str(pricing.discount ?? ''),
    urgentFee: str(pricing.urgent_fee ?? pricing.urgentFee ?? ''),
    taxHandling: str(pricing.tax_handling ?? pricing.taxHandling ?? ''),
    rulesNotes: str(pricing.notes ?? pricing.rules_notes ?? ''),
  };
  profile.delivery = {
    ...profile.delivery,
    method: str(delivery.method ?? delivery.delivery_method ?? ''),
    timeline: str(delivery.timeline ?? delivery.delivery_timeline ?? ''),
    address: str(delivery.address ?? delivery.delivery_address ?? ''),
    packaging: str(delivery.packaging ?? ''),
    deliveryNotes: str(delivery.notes ?? delivery.delivery_notes ?? ''),
  };
  profile.candidature = {
    totalCandidature: numOrUndefined(cand.total ?? cand.total_candidature ?? d.total_candidature),
    sittings: str(cand.sittings ?? cand.assessment_sittings ?? d.assessment_sittings ?? ''),
    spec: str(cand.spec ?? cand.assessment_spec ?? d.assessment_spec ?? ''),
  };
  return profile;
};

const clean = (obj: Record<string, any>): Record<string, any> => {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = v;
  }
  return out;
};

/**
 * Serialise the profile back into the `data` bag. Keeps the flat legacy
 * keys (`total_candidature`, `assessment_spec`, `charge_per_candidate`,
 * `assessment_sittings`) in sync for the schedule document, and stores the
 * full structured blocks under `contract_profile` (+ mirrored top-level
 * blocks for forward compatibility with older readers).
 */
export const buildContractProfileData = (profile: ContractProfile): Record<string, any> => {
  const printSpec = clean({
    paper_size: profile.printSpec.paperSize?.trim() || undefined,
    paper_type: profile.printSpec.paperType?.trim() || undefined,
    paper_weight: profile.printSpec.paperWeight?.trim() || undefined,
    color_mode: profile.printSpec.colorMode?.trim() || undefined,
    sides: profile.printSpec.sides?.trim() || undefined,
    pages_per_copy: profile.printSpec.pagesPerCopy?.trim() || undefined,
    copies: profile.printSpec.copies?.trim() || undefined,
    orientation: profile.printSpec.orientation?.trim() || undefined,
    finishing: profile.printSpec.finishing?.trim() || undefined,
    packaging: profile.printSpec.packaging?.trim() || undefined,
    notes: profile.printSpec.specNotes?.trim() || undefined,
  });
  const pricingRules = clean({
    model: profile.pricingRules.model?.trim() || undefined,
    charge_per_candidate: profile.pricingRules.chargePerCandidate,
    discount: profile.pricingRules.discount?.trim() || undefined,
    urgent_fee: profile.pricingRules.urgentFee?.trim() || undefined,
    tax_handling: profile.pricingRules.taxHandling?.trim() || undefined,
    notes: profile.pricingRules.rulesNotes?.trim() || undefined,
  });
  const deliveryTerms = clean({
    method: profile.delivery.method?.trim() || undefined,
    timeline: profile.delivery.timeline?.trim() || undefined,
    address: profile.delivery.address?.trim() || undefined,
    packaging: profile.delivery.packaging?.trim() || undefined,
    notes: profile.delivery.deliveryNotes?.trim() || undefined,
  });
  const candidature = clean({
    total_candidature: profile.candidature.totalCandidature,
    assessment_sittings: profile.candidature.sittings?.trim() || undefined,
    assessment_spec: profile.candidature.spec?.trim() || undefined,
  });
  return {
    contract_profile: clean({
      print_spec: Object.keys(printSpec).length > 0 ? printSpec : undefined,
      pricing_rules: Object.keys(pricingRules).length > 0 ? pricingRules : undefined,
      delivery_terms: Object.keys(deliveryTerms).length > 0 ? deliveryTerms : undefined,
      candidature: Object.keys(candidature).length > 0 ? candidature : undefined,
    }),
    // Mirrored blocks (older readers look here).
    print_spec: Object.keys(printSpec).length > 0 ? printSpec : undefined,
    pricing_rules: Object.keys(pricingRules).length > 0 ? pricingRules : undefined,
    delivery_terms: Object.keys(deliveryTerms).length > 0 ? deliveryTerms : undefined,
    // Flat legacy keys consumed by the schedule document.
    total_candidature: profile.candidature.totalCandidature,
    assessment_spec: profile.candidature.spec?.trim() || undefined,
    charge_per_candidate: profile.pricingRules.chargePerCandidate,
    assessment_sittings: profile.candidature.sittings?.trim() || undefined,
  };
};

/** One-line human summary for overview cards / empty-state hints. */
export const summarisePrintSpec = (p: ContractPrintSpec): string => {
  const bits = [
    p.paperSize,
    p.paperType,
    p.paperWeight ? `${p.paperWeight}gsm` : '',
    p.colorMode,
    p.sides,
    p.pagesPerCopy ? `${p.pagesPerCopy}pp` : '',
    p.copies ? `×${p.copies}` : '',
    p.orientation,
  ]
    .map((s) => str(s).trim())
    .filter(Boolean);
  const head = bits.join(' · ');
  const tail = [p.finishing, p.packaging].map((s) => str(s).trim()).filter(Boolean).join(' · ');
  if (head && tail) return `${head} — ${tail}`;
  return head || tail || '';
};

export const hasAnyProfileData = (p: ContractProfile): boolean =>
  summarisePrintSpec(p.printSpec) !== '' ||
  str(p.printSpec.specNotes).trim() !== '' ||
  str(p.pricingRules.model).trim() !== '' ||
  p.pricingRules.chargePerCandidate !== undefined ||
  str(p.pricingRules.discount).trim() !== '' ||
  str(p.pricingRules.urgentFee).trim() !== '' ||
  str(p.pricingRules.taxHandling).trim() !== '' ||
  str(p.pricingRules.rulesNotes).trim() !== '' ||
  str(p.delivery.method).trim() !== '' ||
  str(p.delivery.timeline).trim() !== '' ||
  str(p.delivery.address).trim() !== '' ||
  str(p.delivery.packaging).trim() !== '' ||
  str(p.delivery.deliveryNotes).trim() !== '' ||
  p.candidature.totalCandidature !== undefined ||
  str(p.candidature.sittings).trim() !== '' ||
  str(p.candidature.spec).trim() !== '';
