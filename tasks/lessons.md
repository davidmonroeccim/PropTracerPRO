# PropTracerPRO — Lessons

Patterns captured after corrections from David. Review at session start.

---

## L-018: Wiring N call sites and testing two of them is L-016 inside the mutation run (2026-09-18)

**What happened.** Making Full Property Trace reach the CRM required every push site to record which
trace it pushed. Seven sites were wired correctly. The implementer's own tests covered two. Then the
mutation run: strip the trace id from site three, four, five, six, seven, and **five mutations
SURVIVED in a row**. Every one of those sites would have pushed to a customer's CRM and recorded
nothing, and the suite would have stayed green forever.

**Why this is not just "write more tests".** The work was CORRECT. Reading the diff shows seven
sites, all wired, all identical in shape. The tests that existed passed and were about the right
thing. Nothing in the code or the tests looked wrong, because nothing WAS wrong. What was missing
was a fence, and a missing fence is invisible in exactly the way L-015 keeps describing: you cannot
see it by reading, only by breaking the thing and watching nothing happen.

**The mechanism, and it is L-016 moved from the plan into the verification.** L-016 says an
enumerated list suppresses the search that would find item six. This is the same failure one level
down: having wired seven sites, the implementer mutated the sites the BRIEF named rather than asking
"what is the set of things that could individually break here, and is each one fenced?" The brief
said "record at EVERY push site". The tests covered the two the brief discussed by name.

**The rules.**
- **When a change touches N call sites, the mutation count is a function of N, not of the brief.**
  Mutate every site, not a representative one. "They are all the identical two-line shape" is the
  claim under test, not a reason to skip it.
- **A shared helper does not fence its callers.** Testing the helper thoroughly proves the helper
  works. It proves nothing about whether site five passes it the right arguments, and that is a
  different defect with the same symptom: silence.
- Corollary for whoever writes the brief, and it is mine again: I wrote "record at EVERY push site"
  and then listed the mutations to run, and my list named five of the seven. The predicate was right
  and the list under it was short, which is precisely the L-016 shape I had already written down.

**The counterweight, so this does not become "mutate everything forever".** In the same run, two
mutations were correctly identified as EQUIVALENT: removing a type guard changed no runtime
behaviour because a second guard subsumed it, and the mutant was caught by `tsc` rather than by a
test. Verified by running `npx tsc --noEmit` on the mutant and reading the TS2322. **An equivalent
mutant must be reported as equivalent with its evidence, never counted as a kill and never "fixed"
by manufacturing a test that casts its way into an impossible state.** See
[[feedback_no_impossible_edge_cases]].

---

## L-017: `information_schema.column_privileges` cannot answer "will a NEW column be covered" (2026-09-18)

**What happened.** Adding three columns to `user_profiles` for the HighLevel credential flag, I did
the L-014 thing correctly and read the table's grants before writing the migration. I queried
`information_schema.column_privileges`, got one row per column per verb, and concluded the table used
COLUMN-level grants. From that I reasoned that a new column would be invisible to `authenticated`
unless I granted SELECT explicitly, and that the integrations page's `select('*')` would otherwise
42501 for all 53 users. I wrote that into the migration header as the justification for the GRANT.

**All of it was wrong, and the migration was already applied before I caught it.** That view expands
a TABLE-wide grant into one row per column, so a table-wide grant and 28 individual column grants are
indistinguishable in it. The authority is the ACL itself:

```sql
select unnest(relacl)::text from pg_class where oid='public.user_profiles'::regclass;
--   anon=ardDxtm/postgres   authenticated=ardDxtm/postgres   service_role=arwdDxtm/postgres
```

`a`=INSERT `r`=SELECT `w`=UPDATE `d`=DELETE `D`=TRUNCATE `x`=REFERENCES `t`=TRIGGER `m`=MAINTAIN.
SELECT and INSERT were table-wide all along, so the new columns were covered the instant they
existed and my GRANT was a no-op.

**How I caught it, and this is the transferable part.** Not by re-reading my reasoning, which was
internally consistent. By **reading the ACL back after applying** and finding one value I could not
explain: `has_column_privilege(..., 'INSERT')` returned TRUE on a column I had never granted INSERT
on. I could have shrugged at that, since it was harmless. Chasing the one unexplained value is what
exposed the whole misreading. **An audit that returns something you did not predict has found
something, even when what it found is benign.**

**What survived the correction, and why it is worth separating.** The guarantee that actually
mattered held: UPDATE is absent for `anon` and `authenticated`, so the flag cannot be cleared from
the browser. I had the right outcome for a wrong reason. That is the dangerous shape, because the
green result hides the bad reasoning, and the next person inherits the reasoning rather than the
outcome. Getting the right answer is not evidence the method was sound.

**The rules.**
- For "is this grant table-wide or column-scoped", read `relacl`. `information_schema` cannot tell
  you, and the question only ever matters when you are ADDING a column.
- This is a cousin of the known trap that `information_schema.role_table_grants` is filtered by the
  querying role. Same family: the convenience view silently loses the distinction you came for.
- **Read the ACL back after applying, and account for every value you did not predict.** The
  unexplained TRUE is the finding.
- The same read also turned up a table-wide DELETE to `anon` and `authenticated`, blocked today only
  by RLS carrying zero DELETE policies. I would not have looked at DELETE at all if I had trusted my
  first answer, because my first answer never mentioned it.

---

## L-016: An enumerated list stops the reader searching, so an incomplete one is worse than none (2026-09-18)

**What happened, three times in one phase.** Phase 5c's plan enumerated the user-facing strings that
had gone false, with line numbers. It read as exhaustive. It was not, and each gap was found by
something other than the list:

- The **API docs page** (`app/(dashboard)/settings/api-keys/docs/page.tsx`) still told callers that
  blank-owner rows are skipped and free, that a `skip_reason` means nothing was charged, and showed
  two response keys that had already been deleted. Squarely inside the task, absent from the list.
  The implementer's own diagnosis: *"working the brief's enumerated list instead of grepping for the
  claims themselves."*
- The **enqueue itself** had no task number. It existed only in a sentence of prose, and it was the
  capability the whole phase was for.
- **`BLANK_OWNER_SKIP_REASON`'s instruction** was named in one place and survived in three others,
  one of which became customer-visible for the first time in the commit that was supposedly fixing it.

**The mechanism.** A list of five items with line numbers is an implicit promise that there are five.
A careful worker then works the list carefully, and the care is spent on the wrong thing: verifying
each named item rather than asking what else is true of the same kind. Handing someone a good list
actively suppresses the search that would find item six. A vague instruction ("find every string that
says a blank-owner row is free") produces a grep; a precise list produces five edits.

**The rules.**
- **Write the PREDICATE, then the list as examples.** "Every string claiming a blank-owner row is
  skipped or free, including these five" costs four words and restores the search.
- **When you are handed a list, grep for the property before you start.** If the grep agrees with the
  list, you have lost a minute. If it does not, you have found the item that would have shipped.
- **Say out loud whether a list is a floor or a ceiling.** Most lists in a plan are floors and every
  one of them reads like a ceiling.

Corollary for whoever writes the plan, and this one is mine: I produced all three of the gaps above,
and in each case the missing piece was a thing I knew and did not write down, because prose felt
sufficient. Anything load-bearing that lives only in a sentence will be missed by someone working a
task list, and that is not their failure.

---

## L-015: Asserting two outputs DIFFER is weaker than asserting what each one SAYS (2026-09-18)

**What happened.** 5c-3A had to stop `deductOrZero` reporting a short wallet and an RPC error as the
same thing, because one is an expected business outcome and the other is an infrastructure failure,
and PTP has no alerting channel so the log is the only place an operator can tell them apart. The
implementer wrote the fix, then wrote a test asserting the two log lines DIFFER, then mutated the
code to collapse the classification.

**The mutation SURVIVED.** The test still passed, because the two lines still differed: the vendor's
own message text was different in each case even though both had been re-labelled as our database
breaking. The assertion was satisfied by an incidental difference while the meaningful distinction,
whose fault it is, had been destroyed. Re-written to assert the CLASSIFICATION each line carries, the
mutation goes red.

**The general form.** "These two outputs are not equal" is a much weaker claim than it looks, because
any incidental variation satisfies it: a timestamp, an id, an interpolated vendor string. If the
thing you care about is WHICH of two categories an output belongs to, assert the category. A
difference test cannot tell you that the difference is the one that matters.

**This family now has five members** and they are worth reading together, because each produces a
green test that would stay green if the thing it guards were deleted:
- **L-009**, two branches identical by default because a flag collapses them.
- **L-012**, a mutation that never applied, and a file that stopped loading.
- **L-013**, an assertion satisfied by state left over from an earlier test.
- **L-015**, an assertion satisfied by an incidental difference rather than the meaningful one.
- **A RECIPROCAL guard asserted on only one side** (2026-09-18, 5c-3B). Two files deliberately differ
  and each carries a comment explaining why. A test read each file for its OWN reason, so deleting
  the other file's half of the explanation turned nothing red. The half most likely to be tidied away
  by someone reading one file without the other was behind no assertion at all. **A test that reads
  source is only as good as the specific sentence it names**, and a guard on a mutual relationship
  has to assert both ends or it guards one.

The common defence is the same in all five: **mutate the guard and watch it go red, and when it
survives, do not assume the guard is fine because the test looks right.** Four of these five were
invisible to reading and were caught only by the mutation run.

**And note where they were caught.** Every one of these was found by the person who WROTE the guard,
running a mutation against their own work, not by a reviewer reading it. A reviewer reads the test and
the code and sees them agree, which is exactly what a worthless test looks like from the outside.

**The uncomfortable part: this family recurred TWICE MORE in phase 5c after this lesson was written
mid-phase.** The whole-phase review found three tests asserting `?? null`, satisfied by the key being
ABSENT rather than null. Then the implementer fixing that finding wrote a new test asserting
`toContain('records_failed')`, satisfied by the JSX rather than the interface field it meant to check,
and caught it on its own mutation run. **Knowing the pattern did not prevent it.** The pattern is not
a thing you avoid by remembering it; it is a thing you find by mutating. Treat "I have read L-015" as
worth nothing and the mutation run as worth everything.

---

## L-013: A spy you never clear is a fence that cannot fail (2026-09-18)

**What happened.** Writing the test that proves a contact-vendor outage gets logged, the 5c-2
implementer found that `vi.spyOn(console, 'error')` returns the **same spy object** on a second call.
The suite's `beforeEach` re-spies but does not clear, so call history accumulated across tests. The
assertion "an outage writes a log line" passed because an EARLIER test had written one. Its own
mutation would have been reported as killed by another test's output. `.mockClear()` fixed it.

**Checked, not assumed:** the other three cron test files (`sweep-stale-traces`,
`sweep-entity-traces`, `sweep-business-traces`) use the identical un-cleared pattern. None of them
asserts on the console spy today, so all three are LATENT rather than broken. Left alone
deliberately, minimal-impact rule, and recorded here so the next person who adds a log assertion to a
cron test does not step in it.

**The general form, and it is the third member of a family.** L-009 was a test whose two branches
were identical by default. L-012 was a mutation that never applied. This is an assertion satisfied by
state from outside the test. All three produce the same artifact: **a green test that would stay
green if the thing it guards were deleted.** Before trusting any assertion about a side effect
(a log, a counter, a spy, a queue), ask what else in the run could have produced the evidence, and
clear it.

---

## L-014: A DEFERRAL is a decision with an expiry date, and new code can expire it (2026-09-18)

**I nearly recorded this lesson wrong, and the wrong version is instructive.** My first draft said a
previous audit had MISSED that `public.trace_history` grants `INSERT, UPDATE, DELETE` to `anon` and
`authenticated` table-wide. It did not miss it. Reading the actual remediation record rather than my
summary of it, the suite-wide table-grant class was found, understood, and partly fixed on
2026-07-16 and 17, and the broad `REVOKE ... ON ALL TABLES` plus surgical re-grant was **explicitly
DEFERRED** as backward-incompatible and "not flag-critical, profile and wallet tables already
locked". `trace_history` is not an oversight. It is the known, deliberately-deferred remainder.

**And that deferral was reasonable when it was made.** With writes limited to `charge`,
`is_successful`, `trace_result` and the like, the exposure was a user corrupting their own rows. Bad,
but not theft: the wallet ledger is the source of truth for money collected, and `collectedChargeFor`
reads the ledger rather than the row.

**What changed is the table, not the grant.** Phase 5c-2 added `property_trace_status` to it. A new
column inherits the table's existing grants automatically, so it landed browser-writable like every
other column. But it is not a fact about a row: it is the **trigger the cron claims work from**.
Writing `'queued'` into it enqueues paid vendor work. Combined with `deductOrZero` collapsing an
empty wallet to 0 while still delivering, a user with no balance could self-enqueue unlimited tier 2
traces against a Tracerfy pool SHARED with every other customer. A data-integrity deferral quietly
became a free-vendor-work exploit, and nobody re-opened the decision because nobody had to: the
migration only added columns.

**The rules, and the second one is the real one.**

- **Adding a column to a table whose grants you have not read is a privilege decision, not a schema
  decision.** Read the table's grants when you touch it, not just the object you changed. Use
  `has_table_privilege()` / `has_column_privilege()` as an admin: `information_schema.role_table_grants`
  is filtered to grants the QUERYING role can see, so auditing as a low-privilege role returns zero
  rows and a wide-open table looks clean. That filtering hid a different instance of this same class
  for a month.
- **When you defer a security fix, write down what the deferral DEPENDS ON, not just why it is safe
  today.** "Not flag-critical, profile and wallet tables already locked" was true and is now
  irrelevant, because the thing that changed was not the flag or the profile tables. A deferral whose
  justification names only present conditions cannot tell you when it has expired, and the person who
  expires it will be someone adding a column who never reads the security record at all.

**And on recording lessons:** check the primary record before writing the post-mortem. I was about to
blame an audit that had done its job, which would have taught the next reader to distrust a
remediation that was actually sound, and would have buried the real finding.

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

---

## L-011: A handoff's OPEN list is its least reliable section (2026-09-17)

**What happened.** Phase 5 inherited a bullet under "STILL OPEN, NOT FIXED, NOT HIDDEN": a grant
holder billed by owner type on v1 bulk, $0.25 for person rows and $0.15 for entity rows in one
batch, flagged as David's call. David gave a ruling on it. Before implementing the ruling I traced
all six surfaces and both crons, and **the defect could not fire.** It was already fixed by a
source-aware `tier1RateFor` in the same session that wrote the bullet, and independently foreclosed
by the v1 auth gate, which admits only the profiles for which both rate derivations return the same
number.

**Why this section specifically.** The rest of a handoff records what WAS done, and is written after
the doing. An OPEN list records what was NOT done, and is written *before the session ends*. Any fix
that lands in the remaining hours makes it stale, and nothing re-reads it. The measured sections of
these documents have been reliable all build; it is the forward-looking list that rots.

**The rule.** An inherited OPEN item is a hypothesis, not a fact. Before acting on one — and
especially before asking David to rule on one — prove it can still fire. Ask which single
predicate, if already true, would make the two sides identical, then go and check that predicate.
That is L-009 pointed at a document instead of at a test.

**The near miss worth naming.** Had I not checked, I would have "fixed" a live billing path on a
ruling given about a defect that did not exist, and written a test proving a distinction that the
v1 auth gate makes unreachable. It would have passed review, because the reviewer would have
audited it against the same stale bullet. That is the same shape as L-005: two artifacts agreeing
with each other and both wrong.

**And the flag underneath it, which is WORSE than L-009 recorded.** `NEXT_PUBLIC_SUITE_SIGNIN_ENABLED`
is `false` in `.env.local` but **`true` in production**, verified 2026-09-17 by fetching
`https://proptracerpro.com/login` and finding "Sign in with Suite" and `/api/auth/suite/start` in
the served HTML, both of which render only inside `isSuiteSignInEnabled()`.

So the two pricing derivations are **provably identical in every test and genuinely divergent in
production**. This is not a dormant trap, it is the live configuration. A grant-holding wallet-tier
user pays $0.15 through `chargePerTrace` and $0.25 through `getChargePerTrace` right now, and no
test in the suite can tell those apart unless it sets the flag itself.

Every test asserting those two paths differ MUST set the flag inside the test. This is the third
time this one flag has produced a test asserting a tautology. See L-009, earned twice in phase 4.

---

## L-012: A mutation harness that keys temp files on `basename` will eat your work (2026-09-18)

**What happened.** Verifying phase 5b I mutated three files at once and backed each up to
`/tmp/$(basename $f).bak`. Two of them were `app/api/cron/sweep-business-traces/route.ts` and
`app/api/cron/sweep-entity-traces/route.ts`. In a Next.js app **every route file is named
`route.ts`**, so the second backup silently overwrote the first. The restore then wrote the wrong
file into one path and errored on the other, destroying ~440 lines of uncommitted work and leaving
a second file still mutated.

**Why it was survivable, and it was luck.** `npm run build` had run after the implementer finished,
and Next embeds full original source in its sourcemaps. The file came back out of
`.next/server/chunks/*.js.map` intact, 20,202 bytes, verified against known markers (2
`p_trace_history_id`, the `alreadyCollected > 0` guard, `shouldDeliver`/`shouldBill`, 7
`isCacheHitRow`) before writing it back. A stale build, or no build, and it was gone. **That is not
a safety net, it is an accident.**

**The rules.**
- Never key a temp file on `basename` in this repo. Sanitise the full path
  (`echo "$f" | tr '/' '~'`) or use `git stash`.
- **Checksum the restore.** Store a `shasum` next to each backup and fail loudly if the restored
  file does not match. A silent bad restore looks exactly like a good one.
- Commit before a mutation run, or accept that the run can destroy the work it is verifying.

**The second half, and it is the same failure in a different place.** In the same session two
mutations reported clean suites that were NOT results: one `sed` never matched its anchor, and one
edit broke a file so badly that 80 tests silently stopped loading (the total dropped from 933 to
853 while reporting "853 passed"). **A mutation that did not apply, a file that will not load, and
a genuinely surviving guard are indistinguishable from the pass/fail line alone.** Every mutation
must assert its anchor matched exactly once, and every run must confirm the TOTAL test count did
not drop. Cf. L-009: this is the same lesson as a test whose two branches are equal by default,
moved from the test to the tool that checks the test.
