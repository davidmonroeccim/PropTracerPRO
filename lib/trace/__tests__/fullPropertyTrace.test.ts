import { describe, expect, it } from "vitest";
import {
  hasContactData,
  isFullPropertyTrace,
  parcelForFullTrace,
  traceResultFor,
} from "@/lib/trace/fullPropertyTrace";
import { planRoute } from "@/lib/routing/ownerRoute";
import type { ExecutionResult } from "@/lib/routing/executeRoute";

/**
 * The pure glue between the route executor and the two trace_history columns
 * that hold tier 2's output. The billing decisions live in the route; these
 * pin the shaping, which is where a paid-for field goes missing quietly.
 */

const execution = (over: Partial<ExecutionResult> = {}): ExecutionResult => ({
  success: true,
  ownerFound: false,
  learnedZip: null,
  ownerName: null,
  ownerType: "unknown",
  property: null,
  mailingAddress: null,
  contactsFound: false,
  contacts: null,
  tier: 2,
  vendorSpend: 0,
  steps: [],
  needsManualReview: false,
  warnings: [],
  ...over,
});

const CONTACTS = {
  ownerName: "Testowner Placeholder",
  phones: [{ number: "5550000101", type: "mobile" }],
  emails: ["principal@example.invalid"],
  mailingAddress: "100 Placeholder Way, Redacted, ZZ, 00000",
};

describe("isFullPropertyTrace", () => {
  it("triggers automatically when the owner of record is absent", () => {
    expect(isFullPropertyTrace({})).toBe(true);
    expect(isFullPropertyTrace({ owner_name: "   " })).toBe(true);
  });

  it("triggers on the explicit opt-in even with an owner", () => {
    expect(isFullPropertyTrace({ owner_name: "ACME LLC", full_property_trace: true })).toBe(true);
  });

  it("does not trigger for a plain tier 1 trace", () => {
    expect(isFullPropertyTrace({ owner_name: "ACME LLC" })).toBe(false);
    expect(isFullPropertyTrace({ owner_name: "ACME LLC", full_property_trace: false })).toBe(false);
  });

  it("only a literal true opts in", () => {
    // A truthy string from a loosely typed client must not start billing per
    // record. The flag is read strictly for the same reason the deduct is.
    expect(isFullPropertyTrace({ owner_name: "ACME LLC", full_property_trace: "yes" })).toBe(false);
    expect(isFullPropertyTrace({ owner_name: "ACME LLC", full_property_trace: 1 })).toBe(false);
  });
});

describe("parcelForFullTrace", () => {
  it("plans from the address, with no owner name", () => {
    // Tier 2 is dossier-first: planRoute with an owner name present returns a
    // tier 1 plan and never buys the property record the customer asked for.
    // MUTATION: pass the caller's owner_name through and the route's opt-in
    // test goes red.
    expect(parcelForFullTrace({ address: "123 Main St", city: "Austin", state: "tx", zip: "78701" })).toEqual({
      state: "TX",
      situsAddress: "123 Main St",
      situsCity: "Austin",
      situsState: "TX",
      situsZip: "78701",
      parcelIdLocal: null,
      county: null,
      ownerName: null,
    });
  });

  it("carries a null zip rather than an empty string", () => {
    // planRoute omits the zip from the request when it is falsy; an empty
    // string would be sent as a key the vendor cannot match on.
    expect(parcelForFullTrace({ address: "1 A St", city: "B", state: "UT" }).situsZip).toBeNull();
    expect(parcelForFullTrace({ address: "1 A St", city: "B", state: "UT", zip: "  " }).situsZip).toBeNull();
  });
});

describe("traceResultFor", () => {
  it("puts the contact person in owner_name and the owner of record in owner_name_2", () => {
    const result = traceResultFor(
      execution({ ownerName: "Colmaven, Llc", contacts: CONTACTS, contactsFound: true })
    );
    expect(result).toMatchObject({
      owner_name: "Testowner Placeholder",
      owner_name_2: "Colmaven, Llc",
      emails: ["principal@example.invalid"],
      match_confidence: 80,
    });
  });

  it("never lets a company name become the contact person", () => {
    // resolveOwnerContact's rule, and the reason the Dallas run dropped 45
    // resolved people: a column called "owner name" matched the company the
    // customer already had.
    const result = traceResultFor(execution({ ownerName: "Colmaven, Llc" }));
    expect(result!.owner_name).toBeNull();
    expect(result!.owner_name_2).toBe("Colmaven, Llc");
  });

  it("keeps the owner of record when the contact step found nothing", () => {
    // The owner of record is the most valuable thing the $0.20 bought, and the
    // 86-key property object carries no owner field at all.
    const result = traceResultFor(execution({ ownerName: "Colmaven, Llc" }));
    expect(result).not.toBeNull();
    expect(result!.phones).toEqual([]);
    expect(result!.match_confidence).toBe(0);
  });

  it("prefers the contact vendor's mailing address over the dossier's", () => {
    // The contact vendor's belongs to the PERSON it named; the dossier's
    // belongs to the owner of record.
    const result = traceResultFor(
      execution({
        ownerName: "Colmaven, Llc",
        contacts: CONTACTS,
        mailingAddress: { address: "1201 E Wilmington Ave", city: "Salt Lake City", state: "UT", zip: "84106" },
      })
    );
    expect(result!.mailing_address).toBe("100 Placeholder Way, Redacted, ZZ, 00000");
  });

  it("falls back to the dossier mailing address, split across the four columns", () => {
    const result = traceResultFor(
      execution({
        ownerName: "Colmaven, Llc",
        mailingAddress: { address: "1201 E Wilmington Ave", city: "Salt Lake City", state: "UT", zip: "84106" },
      })
    );
    expect(result).toMatchObject({
      mailing_address: "1201 E Wilmington Ave",
      mailing_city: "Salt Lake City",
      mailing_state: "UT",
      mailing_zip: "84106",
    });
  });

  it("normalizes a phone type outside the union rather than casting it through", () => {
    const result = traceResultFor(
      execution({
        ownerName: "Someone Placeholder",
        contacts: { ...CONTACTS, phones: [{ number: "5550000101", type: "Wireless" }] },
      })
    );
    expect(result!.phones[0].type).toBe("unknown");
  });

  it("is null only when there is genuinely nothing", () => {
    expect(traceResultFor(execution())).toBeNull();
  });
});

describe("hasContactData", () => {
  it("is the tier 1 definition, unchanged", () => {
    expect(hasContactData(null)).toBe(false);
    expect(traceResultFor(execution({ ownerName: "Colmaven, Llc" }))).not.toBeNull();
    expect(hasContactData(traceResultFor(execution({ ownerName: "Colmaven, Llc" })))).toBe(false);
    expect(
      hasContactData(traceResultFor(execution({ ownerName: "X", contacts: CONTACTS })))
    ).toBe(true);
  });
});

describe('parcelForFullTrace with a parcel id', () => {
  it('populates parcelIdLocal and county so hasApn can finally be true', () => {
    const parcel = parcelForFullTrace({
      address: '203 Dauphin St', city: 'Mobile', state: 'al', zip: '36602',
      apn: 'R022901', county: 'Mobile',
    })
    expect(parcel.parcelIdLocal).toBe('R022901')
    expect(parcel.county).toBe('Mobile')
    // The THIRD part of the APN key. Already carried, asserted here so a refactor that
    // drops it is caught: an apn and a county without a state is a malformed request.
    expect(parcel.state).toBe('AL')
  })

  it('leaves both null when no parcel id is supplied, which is every caller today', () => {
    const parcel = parcelForFullTrace({ address: '203 Dauphin St', city: 'Mobile', state: 'AL' })
    expect(parcel.parcelIdLocal ?? null).toBeNull()
    expect(parcel.county ?? null).toBeNull()
  })

  it('treats a blank parcel id as absent, never as a value', () => {
    // CLAUDE.md rule 7: no placeholder data. An empty string would make hasApn() true and
    // send a request with an empty apn, which the vendor charges nothing for and answers
    // with nothing, so it would be an invisible waste rather than an error.
    const parcel = parcelForFullTrace({
      address: '203 Dauphin St', city: 'Mobile', state: 'AL', apn: '   ', county: '',
    })
    expect(parcel.parcelIdLocal ?? null).toBeNull()
    expect(parcel.county ?? null).toBeNull()
  })

  it('emits BOTH dossier steps, APN first, when both keys exist', () => {
    const plan = planRoute(parcelForFullTrace({
      address: '203 Dauphin St', city: 'Mobile', state: 'AL', apn: 'R022901', county: 'Mobile',
    }), 'pro')
    expect(plan.steps.map((s) => s.kind)).toEqual(['DOSSIER_APN', 'DOSSIER_ADDRESS'])
  })

  it('sends apn, county AND state on the APN step', () => {
    // The three-part key. A request with two of the three is malformed and the vendor
    // answers it with a miss, which is free and therefore silent.
    const plan = planRoute(parcelForFullTrace({
      address: '203 Dauphin St', city: 'Mobile', state: 'AL', apn: 'R022901', county: 'Mobile',
    }), 'pro')
    const apnStep = plan.steps.find((s) => s.kind === 'DOSSIER_APN')!
    expect(apnStep.request).toEqual({ apn: 'R022901', county: 'Mobile', state: 'AL' })
  })

  it('still emits the address step alone when only a situs exists', () => {
    // The regression fence for every caller that exists today. Address mode is the proven
    // key and must not become conditional on a parcel id arriving.
    const plan = planRoute(
      parcelForFullTrace({ address: '203 Dauphin St', city: 'Mobile', state: 'AL' }), 'pro',
    )
    expect(plan.steps.map((s) => s.kind)).toEqual(['DOSSIER_ADDRESS'])
  })
})
