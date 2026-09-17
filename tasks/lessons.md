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

## L-008: Read the saved payloads before writing the client (2026-09-17)

Three times today the real vendor responses in `tasks/research-test/` contradicted a plan I had
written from prose, and each one would have shipped silently.

- The plan said the dossier's `property` object carries the owner. **It does not.** The owner is in
  `response.owners[]`, and an entity arrives as `{first_name: "", last_name: "Colmaven, Llc"}` with
  the whole name in `last_name`. A client built from the plan returns no owner, and tests written
  from the same plan agree with it.
- A FastAppend MISS carries an `error` string next to `hit:false`. Reading that as a failure makes
  every billable miss **unbillable**, silently giving away revenue.
- `role` is a comma-separated list: `"REGISTERED AGENT,MANAGER"`. Filtering out everyone the flag
  marks discards 20% of paid hits.

**The rule.** When a vendor payload is on disk, open it before writing the code that parses it. A
summary of a response is not a response. This applies with more force when the summary is one I
wrote myself, because then the code and the tests inherit the same wrong model and agree.

**Corollary, learned the same day:** a test written after the implementation, from the same
assumption, proves nothing. Phase 2 wrote 45 characterization tests pinning CURRENT behaviour green
BEFORE changing billing code, precisely so the tests could disagree with the change.

---

## L-007: Bill on whether the call SUCCEEDED, never on whether it FOUND anything (2026-09-17)

Tier 2 bills per record submitted, so a miss is billable. But a vendor outage is not. **Both look
identical from outside: no owner found.**

Gating the charge on `ownerFound` bills customers for Tracerfy being down. Gating on
`ExecutionResult.success` bills the miss and not the outage. Mutation-verified: switching the gate
turns 12 tests red, and skipping the miss charge turns 7 red.

**The general form:** when two outcomes produce the same visible result and only one is billable,
the billing condition must key on the thing that DIFFERS (did we successfully ask?) and never on
the thing they share (did we get an answer?). Write the distinction into a comment at the gate,
because the next reader will see two false-y values and think they can be merged.

---

## L-006: A loose detector produces false alarms indistinguishable from real ones (2026-09-17)

Scanning committable fixtures for leaked PII, my first scan reported 40+ hits and was **wrong**. It
substring-matched key names, so `estimated_mortgage_payment` matched on "age", and the propensity
`_factors` arrays have a literal `name` key whose values are things like `high_equity`. Re-run with
exact key matching and word boundaries it was clean; the three survivors were `Mayfield Dr`,
`Youngstown`, and David's own name in a code comment.

**The danger is not the false alarm, it is what it teaches.** A scanner that cries wolf 40 times
trains its reader to skim the output, and the 41st hit is real. For anything where a miss is
serious — PII, secrets, credentials — tighten the detector until a hit means something, and say out
loud how many candidates were checked so the clean result is auditable.

---

## L-005: Do not let the COST model's dimensions leak into the PRICE model (2026-09-16)

**The correction, which took three passes.** David restated pricing, I implemented it wrong, he
restated it (*"We hashed this already. Here it is AGAIN!"*), I implemented THAT wrong in the
opposite direction, and he corrected it a third time with one sentence: *"The pay as you go owner
known is wrong. It should be $0.25."*

**The actual model.** Two axes, tier and plan, four numbers. Tier 1 (owner known) is $0.15 for
Pro and AcquisitionPRO, $0.25 for pay-as-you-go. Tier 2 is $0.25 and $0.40. **Owner type selects
the VENDOR, not the price.**

**The root cause.** This project has two tables that share a shape and do not share dimensions:

- The **cost** table genuinely has a vendor axis. FastAppend entity contacts $0.10, Tracerfy
  individual contacts $0.10, dossier $0.20. That axis is real and is documented in the handoff.
- The **price** table has no vendor axis at all.

David describes routing and price in the same breath, because to him they are one workflow: *"if
the owner is known and is an entity, the cost is $0.15 per successful trace through fastappend."*
I read the vendor clause as a pricing dimension and manufactured an entity rate that never
existed. The word "cost" in that sentence also means price-to-customer, not vendor cost, which is
the same conflation running the other way.

**The compounding error.** Told a single number for the entity case, I inferred it was FLAT across
plans rather than asking which plan it belonged to. One number for a case that has a plan axis is
an incomplete statement, not a statement of uniformity. I then wrote that invented flat rate into
the handoff as canonical, marked it "do not fix this into a plan split," and wrote a lesson
congratulating myself for recording axes carefully. All three artifacts were confidently wrong.

**The rule.** Before writing any price into code or copy, say out loud which axes PRICE varies on
and which axes only VENDOR or COST varies on. They are different tables. A sentence naming a
vendor is a routing fact until the speaker says the price differs by vendor.

**And: one number for a multi-axis case is missing information, not a flat rate.** When a value
arrives for a case whose axes you know, and the speaker names fewer coordinates than there are
axes, you have an underspecified cell. Ask. Do not resolve it by assuming uniformity, and
absolutely do not then record the assumption as canonical.

**Second-order cost.** Two full implementation passes, an adversarial review, and a customer
notification draft, each internally consistent with a different wrong model. The reviewer could
not catch it because it was auditing against the same bad table.

---

## L-003: Owner TYPE is the product, not just owner NAME (2026-09-16)

The research step's output feeds a routing decision: individual owner goes to Tracerfy, entity owner
goes to FastAppend with the owner name and state of registration. A correct name with the wrong
`owner_type` routes to the wrong vendor and buys a guaranteed miss that still bills.

So correctness has three axes, each independently failable: **name**, **type**, and for entities
**state of registration**. Any measurement of this step that counts only "did it return a name" is
measuring the wrong thing. Trusts are a distinct third case: entity-like, frequently with no SoS
registration at all.

---

## L-009: A test for a flag-gated distinction proves nothing while the flag is off (2026-09-17)

Phase 4 wired tier 2 into the public v1 API. v1 is **Track B** and must price from the RAW
`getChargePerTrace` inputs, never the grant-aware Track A helpers — reusing them would move an
existing API-key caller's bill from $0.40 to $0.25, in the direction nobody reports.

I wrote the guard, wrote a test named "is blind to a gateway grant, because v1 is Track B", and
mutation-tested it by swapping in the Track A helpers. **Zero tests went red.**

The reason: the only thing that separates the two tracks is `hasSuiteAccess()`, which is gated on
`NEXT_PUBLIC_SUITE_SIGNIN_ENABLED`. That flag is off in the test environment, so
`effectiveIsPro()` collapses to the raw predicate, both tracks return `wallet`, and the test passed
under both implementations. It was asserting a tautology with a confident name on it.

**The rule.** When a test exists to prove that two code paths DIFFER, first prove they CAN differ in
the environment the test runs in. If the difference is behind a feature flag, an env var, or a
config toggle, set it inside the test. Otherwise the test pins the collapsed case and reports green
forever.

**How to spot it without a mutation run.** Ask what single value, if changed, would make the two
sides of the comparison identical — then check whether that value is already at its identical
setting in the test environment. A test whose two branches are equal by default is measuring
nothing.

**Why the mutation run is not optional.** This one was invisible to reading. The guard was correct,
the test was correct, the name was correct, and the pair was still worthless. Only deleting the
guard and watching nothing happen exposed it. That is the whole argument for
`feedback_mutation_test_security`: a guard without a test that FAILS when you delete the guard is
not a guard, and a test that keeps passing after you delete it is the evidence.

---

## L-010: Design the producer against the CONSUMER you verified, not the one you pictured (2026-09-17)

**What I built in my head.** Phase 4b was specced as: push the 65 dossier fields into the user's
GoHighLevel as CONTACT custom fields, auto-created over the API, with a Private Integration Token
scope warning for existing users. I researched it properly -- read the live HighLevel docs, pulled
the exact scope strings, confirmed the create endpoint, probed a live location -- and every one of
those facts was correct.

**All of it was aimed at the wrong thing.** David then said, in one sentence, that most users get
this data through the Suite Gateway. Reading the gateway settled it in about twenty minutes:

- The gateway reads PTP over **MCP**, never from PTP's database. No PTP project ref exists anywhere
  in that repo.
- It writes property data to a **custom object**, `custom_objects.property`, not to the Contact.
- `crm_push_owners` **parses** PTP's response by name and silently drops every key it does not
  recognise. Its own pinned fixture already carries `address`, `zip`, `research` and
  `match_confidence` that are discarded today, which is exactly how a new `property_record` would
  behave: invisible, with no error anywhere.
- PTP's gateway-facing surface never emitted `property_record` at all, so there was nothing to map.

So the real PTP-side work was four lines of shape, not an API integration. The auto-create design
targeted an object the gateway does not use, over a permission no user has (our own setup page
tells them to grant only `contacts`), for 6 of 52 users.

**The rule.** Before building a producer, verify the consumer FIRST: how it reads, what shape it
expects, and what it does with a field it does not recognise. That last question is the one that
gets skipped, and it is the one that decides whether a silent drop or a hard error tells you the
integration is wrong. Research quality is not a defence here. Every fact I gathered was true and
the target was still wrong, because I validated the ANSWER and never validated the QUESTION.

**How to spot it.** When work spans two systems, say out loud which side each change lands on and
who reads it. If you cannot name the consuming function and the field it reads, you are designing
against an imagined interface.

**And a smaller error inside the same hour, worth its own line.** I told David the gateway pushed to
GoHighLevel via CSV import. It does not; it uses the REST API record by record. I had inferred it
from a genuine adjacent fact -- the API cannot create property-object fields -- and then stated the
mechanism as though I had checked it. An inference drawn from a verified constraint is still an
inference. Say which one it is, or go and look.
