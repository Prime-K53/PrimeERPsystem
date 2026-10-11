import { describe, it, expect } from 'vitest';
import { buildContractScheduleDoc } from '../../../services/printingContractService';
import { ContractScheduleSchema as PrintingContractScheduleSchema } from '../../../views/shared/components/PDF/schemas';

const baseContract: any = {
  contract_number: 'CTR-TEST-001',
  version: 1,
  status: 'active',
  prepaid_amount: 60000,
  reserved_amount: 0,
  consumed_amount: 0,
  starts_at: new Date('2024-10-15').toISOString(),
  ends_at: new Date('2024-10-18').toISOString(),
  terms: '',
};

const item: any = {
  id: 'item-1',
  assessment_name: 'Midterm',
  assessment_type: 'examination',
  item_price: 1200,
  status: 'reserved',
  reserved_at: new Date('2024-10-15').toISOString(),
  created_at: new Date('2024-10-15').toISOString(),
};

describe('schedule profile (recorded vintage rows)', () => {
  it('carries recorded profile from contract.data into the doc', async () => {
    const doc = await buildContractScheduleDoc({
      contract: {
        ...baseContract,
        data: {
          total_candidature: 50,
          assessment_spec: '8 Pages',
          charge_per_candidate: 1200,
          assessment_sittings: 'Once Off',
        },
      },
      items: [item],
      customerName: 'MUA RC Primary School',
      schoolName: 'Mankhamba ZONE',
    });
    expect(doc.totalCandidature).toBe(50);
    expect(doc.assessmentSpec).toBe('8 Pages');
    expect(doc.chargePerCandidate).toBe(1200);
    expect(doc.assessmentSittings).toBe('Once Off');
    // Must survive the preview validation gate (schema strips unknown keys).
    const parsed = PrintingContractScheduleSchema.parse(doc);
    expect(parsed.totalCandidature).toBe(50);
    expect(parsed.assessmentSpec).toBe('8 Pages');
  });

  it('omits profile on older contracts without recorded data', async () => {
    const doc = await buildContractScheduleDoc({
      contract: { ...baseContract, data: { lines: [] } },
      items: [item],
      customerName: 'Customer',
    });
    expect(doc.totalCandidature).toBeUndefined();
    expect(doc.assessmentSpec).toBeUndefined();
    expect(doc.chargePerCandidate).toBeUndefined();
    expect(doc.assessmentSittings).toBeUndefined();
    expect(() => PrintingContractScheduleSchema.parse(doc)).not.toThrow();
  });
});
