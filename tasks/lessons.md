# PropTracerPRO — Lessons

Patterns captured after corrections from David. Review at session start.

---

## L-001: Don't invert an over-claim into an absolute (2026-09-16)

**The correction.** On 2026-09-15 David corrected a prompt that claimed "in commercial real estate,
the business owner at a property is very often also the property owner." On 2026-09-16 he corrected
the fix:

> "That is not true and the word NEVER is the problem. Some owners do operate out of buildings they
> own, a doctor owning a practice will typically buy the building. An apartment owner of a small
> apartment building may live in one of the units. This needs to be validated, not judged!"

**What I did wrong.** Commit `96178fe` replaced the over-claim with
`A BUSINESS OPERATING AT THE ADDRESS IS NOT THE OWNER (ABSOLUTE)` plus
`stripOperatingBusinessFromOwner()`, a deterministic guard that nulls `owner_name` regardless of
evidence. That is the same unvalidated judgment pointed the other way. It suppresses correct answers
for owner-occupants: medical office, small multifamily with an on-site owner, and the retail case
David closed himself (The Noble South, Mobile AL, 2014, where the restaurant operator owned the
building).

**The rule.** When a heuristic is wrong because it asserts without evidence, replace it with a
**requirement for evidence**, not with an opposite assertion. "Never X" and "usually X" are both
judgments. "X only when the recorder, assessor or SoS confirms it" is a validation.

**How to spot it.** If a fix contains NEVER, ALWAYS, ABSOLUTE, or "not for any type," and the domain
is one where real-world exceptions exist, stop. Ask whether the exception is checkable. If it is
checkable, check it instead of banning it.

**Second-order damage.** An absolute guard also makes the error class **unmeasurable**. A suppressed
correct answer and a genuine absence both emit `owner_name: null`, so no test can tell them apart
and the false-positive direction goes untested even at 175 passing tests.

---

## L-002: Verify the vendor docs before encoding vendor behavior (2026-09-16)

**The correction.** David supplied https://tracerfy.com/skip-tracing-api-documentation/ and noted it
is the source these changes were made from, and that it was almost certainly never recorded in the
handoff or history. He also stated two facts absent from all prior notes:

- Tracerfy does **not** need address, city, state or zip for the individual path.
- FastAppend keys on the entity's **state of registration**, not the property address state.

**What went wrong.** Prior sessions inferred vendor field semantics from PTP's own code and from
response inspection. That produced `mail_state` populated with the PROPERTY state, flagged in the
handoff as "wrong" without anyone identifying WHY it was wrong or what the right value was.

**The rule.** Vendor field semantics come from vendor documentation. Cite the doc URL in the handoff
so the next session does not re-derive it from behavior. Per
`feedback_verify_live_source_not_stale_docs`, a claim reconstructed from code is not a verified
claim about an external API.

---

## L-004: I drifted to owner-occupancy twice after being told the goal (2026-09-16)

**The correction, given twice.** First: "Lets not lose sight that we are determining whether the owner is an entity or individual... I don't want us to only focus on owner operators." Then, after I drifted again: "it appears you are still focused on owner/operators. This is not the goal. We are ONLY identifying if the owner is an individual or an entity, and if it's an entity what state the entity is registered in. Whether the user is the owner is irrelevant as long as the search identifies the owner and does not rely on the tenant to get to that answer."

**What I did wrong.** Owner-occupancy was a genuine defect worth fixing, so I kept enlarging it: an `owner_occupant` flag, a scoring category, an evidence gate, a county-portal false-negative rate. Each step was locally defensible and collectively it replaced the goal. An owner-occupant is still an ENTITY and still routes to FastAppend exactly like any other entity, so detecting it changes no routing decision.

**The rule.** `owner_name` must be backed by an ownership record that names it. Whoever the record names is the answer, including the business operating at the address.

**I got this wrong even while writing this lesson.** My first draft said "a tenant must never become the answer," and David caught it: *"Here you go again with words like never, which will block the result if the user is the owner. STOP doing that!"* That phrasing is [[cre-owner-occupancy-by-asset-class]]'s bug wearing a different hat. It presumes the business at the address is a tenant, which is the assumption that was wrong to begin with.

The defect is never "a tenant got in." It is "a name got in with no record behind it." The name's source is irrelevant: a business at the address, a neighbor, a registered agent, a fabricated LLC all fail for the same reason, which is missing evidence. State the rule as a requirement for evidence. Never as an excluded category. If a rule names a category of thing that may not appear, it is the wrong rule, and rewriting it positively is not a style preference, it is the fix.

**How to spot it.** When a sub-problem is more interesting than the stated goal, that is the warning, not the justification. Before adding a scoring category, a flag, or a measurement, ask which decision it changes. If the answer is none, drop it. Restate the goal in one sentence at the top of each work item and check the item against it.

**The goal here, verbatim:** individual or entity, and if entity, what state of registration. Cost per correctly-routed parcel. Nothing else.

---

## L-003: Owner TYPE is the product, not just owner NAME (2026-09-16)

The research step's output feeds a routing decision: individual owner goes to Tracerfy, entity owner
goes to FastAppend with the owner name and state of registration. A correct name with the wrong
`owner_type` routes to the wrong vendor and buys a guaranteed miss that still bills.

So correctness has three axes, each independently failable: **name**, **type**, and for entities
**state of registration**. Any measurement of this step that counts only "did it return a name" is
measuring the wrong thing. Trusts are a distinct third case: entity-like, frequently with no SoS
registration at all.
