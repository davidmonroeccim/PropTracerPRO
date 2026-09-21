import { describe, it, expect } from 'vitest';
import { resolveOwnerContact } from '@/lib/ai-research/contacts';
import type { AIResearchResult, TraceResult } from '@/types';

// Regression fixtures drawn from the real 2026-08-13 Dallas MCP run, where PTP resolved a
// person behind each entity but the delivered CSV carried only the company name, its phone
// and the person's email. The person's name was present in the payload as `trace_result
// .owner_name` / `business_trace_contacts.owner_name` -- keys that collide semantically with
// `input_owner_name` and `research.owner_name` (both the COMPANY) -- so consumers dropped it.
// resolveOwnerContact gives that person exactly one self-describing name.

function research(over: Partial<AIResearchResult> = {}): AIResearchResult {
  return {
    owner_name: null, owner_type: 'unknown', business_name: null,
    individual_behind_business: null, is_deceased: null, deceased_details: null,
    relatives: [], decision_makers: [], property_type: 'unknown',
    confidence: 0, confidence_reasoning: null, sources: [], ...over,
  };
}

function traceResult(over: Partial<TraceResult> = {}): TraceResult {
  return {
    owner_name: null, owner_name_2: null, phones: [], emails: [],
    mailing_address: null, mailing_city: null, mailing_state: null,
    mailing_zip: null, match_confidence: 0, ...over,
  } as TraceResult;
}

describe('resolveOwnerContact', () => {
  it('prefers the FastAppend business-trace person over every other source', () => {
    // Magnolia Property Company -> Daniel Hamann (real Dallas row).
    const out = resolveOwnerContact({
      trace_result: traceResult({ owner_name: 'Daniel Hamann' }),
      ai_research: research({
        owner_name: 'Magnolia Property Company',
        owner_type: 'business',
        individual_behind_business: 'Daniel Hamann',
        business_trace_contacts: {
          owner_name: 'Daniel Hamann', phones: [], emails: [], address: null,
        },
      }),
    });

    expect(out.owner_contact_name).toBe('Daniel Hamann');
    expect(out.owner_contact_source).toBe('fastappend');
  });

  it('falls back to the person-trace result when FastAppend produced no name', () => {
    // Westdale Real Estate -> Joe Beard (real Dallas row: bt_person was null).
    const out = resolveOwnerContact({
      trace_result: traceResult({ owner_name: 'Joe Beard' }),
      ai_research: research({
        owner_name: 'Westdale Real Estate Investment and Management',
        owner_type: 'business',
        individual_behind_business: 'Joe Beard',
      }),
    });

    expect(out.owner_contact_name).toBe('Joe Beard');
    expect(out.owner_contact_source).toBe('person_trace');
  });

  it('falls back to the researched individual when no trace returned contacts', () => {
    // Bright Realty LLC -> Chris Bright (real Dallas row: status error, no trace_result).
    const out = resolveOwnerContact({
      trace_result: null,
      ai_research: research({
        owner_name: 'Bright Realty LLC',
        owner_type: 'business',
        individual_behind_business: 'Chris Bright',
      }),
    });

    expect(out.owner_contact_name).toBe('Chris Bright');
    expect(out.owner_contact_source).toBe('ai_research');
  });

  it('uses the owner name itself only when the owner IS an individual', () => {
    const out = resolveOwnerContact({
      trace_result: null,
      ai_research: research({ owner_name: 'Peter Lagasse', owner_type: 'individual' }),
    });

    expect(out.owner_contact_name).toBe('Peter Lagasse');
    expect(out.owner_contact_source).toBe('ai_research');
  });

  it('never surfaces a company name as the contact person', () => {
    // The exact defect: an entity with contacts but no resolved human must stay EMPTY,
    // not fall back to the LLC. Deleting the owner_type guard makes this test fail.
    const out = resolveOwnerContact({
      trace_result: null,
      ai_research: research({
        owner_name: 'Fountain Parc Apartments LLC',
        owner_type: 'business',
      }),
    });

    expect(out.owner_contact_name).toBeNull();
    expect(out.owner_contact_source).toBeNull();
  });

  it('returns nulls when there is nothing to resolve', () => {
    expect(resolveOwnerContact({ trace_result: null, ai_research: null })).toEqual({
      owner_contact_name: null,
      owner_contact_source: null,
    });
  });

  it('ignores whitespace-only names rather than reporting a blank contact', () => {
    const out = resolveOwnerContact({
      trace_result: traceResult({ owner_name: '   ' }),
      ai_research: research({
        owner_name: 'Some Holdings LLC',
        owner_type: 'business',
        individual_behind_business: 'Real Person',
      }),
    });

    expect(out.owner_contact_name).toBe('Real Person');
    expect(out.owner_contact_source).toBe('ai_research');
  });
});

describe('resolveOwnerContact reads the RECORDED vendor before it infers one', () => {
  /**
   * THE BUG THIS CLOSES, measured on a real paid row.
   *
   * Trace 5ec0cf47-6844-4514-9029-53a0b6f34cd0, 2026-09-20. County owner of record
   * "Estates Ave Properties Llc", classified `entity`, routed FASTAPPEND_ENTITY, contacts
   * delivered by FastAppend. It was reported to the customer as `person_trace`.
   *
   * The cause is structural, not a typo. The FastAppend rung reads
   * ai_research.business_trace_contacts, and the tier 2 path never writes ai_research at
   * all: its contacts go to trace_result, where tier 1 already puts them. So the first rung
   * cannot fire on tier 2, the second always does, and EVERY tier 2 FastAppend hit is
   * mislabelled. Inference cannot fix that, because both vendors land in the same field.
   *
   * trace_history.contact_vendor (migration 20260921) records which lane was actually asked,
   * so this reads a fact instead of guessing from the storage envelope.
   */
  it('labels a tier 2 FastAppend hit fastappend, not person_trace', () => {
    const out = resolveOwnerContact({
      // Exactly the live row's shape: contacts in trace_result, ai_research null.
      trace_result: traceResult({
        owner_name: 'William Liu',
        owner_name_2: 'Estates Ave Properties Llc',
      }),
      ai_research: null,
      contact_vendor: 'fastappend',
    });
    expect(out.owner_contact_name).toBe('William Liu');
    expect(out.owner_contact_source).toBe('fastappend');
  });

  it('labels a recorded tracerfy lane person_trace', () => {
    // The Tracerfy lanes ARE person skip traces, so the existing value is the honest one
    // and the union does not need to grow for this.
    const out = resolveOwnerContact({
      trace_result: traceResult({ owner_name: 'Testowner Placeholder' }),
      ai_research: null,
      contact_vendor: 'tracerfy',
    });
    expect(out.owner_contact_source).toBe('person_trace');
  });

  it('still returns no contact when the vendor was recorded but named nobody', () => {
    // A recorded lane is not a contact. A dossier that bought the owner of record and
    // reached nobody must not start reporting a name it does not have.
    const out = resolveOwnerContact({
      trace_result: traceResult({ owner_name: null, owner_name_2: 'Acme Holdings Llc' }),
      ai_research: null,
      contact_vendor: 'fastappend',
    });
    expect(out.owner_contact_name).toBeNull();
    expect(out.owner_contact_source).toBeNull();
  });

  it('falls back to the old chain on a row written before the column existed', () => {
    // 3,836 of 3,838 rows predate migration 20260917 and came from Tracerfy normal search
    // or AI Search with FastAppend. They carry no contact_vendor and must keep the label
    // they have always had, not acquire a new one derived from nothing.
    const out = resolveOwnerContact({
      trace_result: traceResult({ owner_name: 'Legacy Person' }),
      ai_research: null,
      contact_vendor: null,
    });
    expect(out.owner_contact_source).toBe('person_trace');
  });

  it('keeps the legacy ai_research label on a legacy row, rather than relabelling it', () => {
    const out = resolveOwnerContact({
      trace_result: null,
      ai_research: research({ individual_behind_business: 'Legacy Principal' }),
      contact_vendor: null,
    });
    expect(out.owner_contact_name).toBe('Legacy Principal');
    expect(out.owner_contact_source).toBe('ai_research');
  });

  it('the recorded vendor OUTRANKS the inferred chain when they disagree', () => {
    // The disagreement is the whole point: business_trace_contacts would say fastappend by
    // inference, and on this row the lane that actually ran was Tracerfy.
    const out = resolveOwnerContact({
      trace_result: traceResult({ owner_name: 'Traced Person' }),
      ai_research: research({
        business_trace_contacts: {
          owner_name: 'Traced Person', phones: [], emails: [], address: null,
        },
      }),
      contact_vendor: 'tracerfy',
    });
    expect(out.owner_contact_source).toBe('person_trace');
  });
})
