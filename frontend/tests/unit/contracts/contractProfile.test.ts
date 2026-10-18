import { describe, it, expect } from 'vitest';
import {
  emptyContractProfile,
  readContractProfile,
  buildContractProfileData,
  summarisePrintSpec,
} from '../../../utils/contractProfile';

describe('contractProfile', () => {
  it('round-trips the four commercial blocks through data', () => {
    const profile = emptyContractProfile();
    profile.printSpec.paperSize = 'A4';
    profile.printSpec.paperType = 'Bond';
    profile.printSpec.colorMode = 'Black & White';
    profile.printSpec.sides = 'Double Sided';
    profile.pricingRules.model = 'per_candidate';
    profile.pricingRules.chargePerCandidate = 1200;
    profile.delivery.method = 'Delivery';
    profile.delivery.address = 'Mankhamba Zone';
    profile.candidature.totalCandidature = 450;
    profile.candidature.sittings = 'Once Off';
    profile.candidature.spec = '8 Pages';

    const data = buildContractProfileData(profile);
    // Legacy flat keys stay in sync for the schedule document.
    expect(data.total_candidature).toBe(450);
    expect(data.assessment_spec).toBe('8 Pages');
    expect(data.charge_per_candidate).toBe(1200);
    expect(data.assessment_sittings).toBe('Once Off');

    const back = readContractProfile(data);
    expect(back.printSpec.paperSize).toBe('A4');
    expect(back.pricingRules.chargePerCandidate).toBe(1200);
    expect(back.delivery.method).toBe('Delivery');
    expect(back.candidature.totalCandidature).toBe(450);
    expect(summarisePrintSpec(back.printSpec)).toContain('A4');
  });

  it('reads legacy flat keys on old contracts with no structured blocks', () => {
    const back = readContractProfile({
      total_candidature: 50,
      assessment_spec: '8 Pages',
      charge_per_candidate: 1200,
      assessment_sittings: 'Once Off',
    });
    expect(back.candidature.totalCandidature).toBe(50);
    expect(back.candidature.spec).toBe('8 Pages');
    expect(back.pricingRules.chargePerCandidate).toBe(1200);
    expect(back.candidature.sittings).toBe('Once Off');
    // Print spec untouched on legacy rows.
    expect(summarisePrintSpec(back.printSpec)).toBe('');
  });
});
