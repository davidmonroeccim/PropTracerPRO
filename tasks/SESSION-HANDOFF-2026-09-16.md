# SESSION HANDOFF, 2026-09-16, amended through 2026-09-21

> # AMENDED 2026-09-21 (afternoon). READ THIS FIRST.
>
> **RESOLVED LATER THE SAME AFTERNOON. David decided: Tier 1 person lookup with a city = INSTANT;
> dossier-found individual = SECOND Tracerfy lookup, name-matched; no first name or initial = FastAppend
> as an entity; Tracerfy never supplies an entity's contacts.** All four are spec decisions D13-D16, in
> his words. The block below is kept as the record of how it went wrong.
>
> **NEXT: Phase 0 plan amendments A1-A4, awaiting David's approval (not yet applied):** A1 trusts that
> strip to no first name or initial get FastAppend only (D16); A2 the multifamily second lookup is judged
> by the name test, so the runner saves the raw vendor response and the analyzer applies D6 (today's
> parser takes persons[0], client.ts:602); A3 read-only registry count of owner-name shapes in the 10
> counties before sampling (Instant sends the split name, splitPersonName reads two words as FIRST LAST);
> A4 spread the 10 multifamily samples across states (plan Task 4 `mf.slice(0, MF_TOTAL)` takes IN and FL
> only). Do not dispatch Task 3+ until David answers. Task 2 (931929b) still needs its review.
>
> **David's answers so far:** A1 YES. A2: "The multifamily records are coming from the registry NOT
> MPS. So if MPS has an owner name and the registry does not, it needs a dossier search and the user
> needs to be notified of that." (spec D17; the Phase 0 multifamily sample must be REGISTRY parcels
> with no owner, not MPS rows the registry cannot find). A3: he asked whether name order is getting
> FIXED or only measured; answer pending. A4: "Do not use those 2 states [IN, FL]. Id 2 states where
> the test matters most, that can find defects, not assume it should all pass."
> **Sampling rule, David, 2026-09-21, for EVERY Phase 0 sample (individuals too):** registry coverage
> required, chosen to FIND DEFECTS: "I don't want like you did in the previous context where kept testing
> the same property after it was already determined to be valid, so it could not find defects from other
> markets or property types." No parcel already tested (anything in tasks/research-test/, e.g. Pinole,
> Napa, Salt Lake) is reused; spread across markets and property types. Candidate MF states proposed:
> New York (municipal city, attacks the address key) and Louisiana (parishes, attacks the APN key);
> Utah (no ZIP) as the alternative. David has not picked yet. A3: asked whether to add a Phase 1
> name-order fix to the spec; no answer yet.
> **Registry coverage, measured 2026-09-21 (read-only, counts only):** NY Onondaga 181,909 parcels
> (89,754 no city), Monroe 267,414 (358 no city), Broome 85,058 (56,804 no city), Oneida 105,058 (17,412
> no city); NY multifamily parcels with NO owner: 0 in all four. LA: Lafayette, Caddo, Calcasieu, Ouachita
> have 0 parcels; parcels_la is ~345k rows, the first 200k East Baton Rouge (22033). UT Weber, Utah,
> Washington, Cache: EVERY parcel has no city and no ZIP; Washington has 4,308 multifamily parcels, all
> with no owner, 2,503 with an APN. PLAN DEFECT found by this: the plan's individual sample REQUIRES a
> city, so it never tests the no-city APN path this whole design exists for.
> **Louisiana, all 64 parish FIPS counted:** the registry holds only East Baton Rouge (22033, 200,163) and
> Jefferson (22051, 144,894). **David, 2026-09-21: every sample group spans PROPERTY TYPES, not just
> multifamily** ("Why are you so focused on Multifamily? I said earlier that I wanted other property
> types tested").
> **Pick every Phase 0 county from the registry inventory,
> `/Users/davidmonroe/property-registry/docs/registry-inventory/county-searchable-coverage.csv`** (1,854 rows,
> 2026-09-01; it has no situs-city column, so measure city fill live, one county at a time).
>
> **(Original block.) Do not run Phase 0.** Its plan (`docs/superpowers/plans/2026-09-21-tier1-phase0-measurement.md`)
> and the spec (`docs/superpowers/specs/2026-09-21-tier1-planroute-design.md`, fbd1891) are built on
> Tracerfy's INSTANT named lookup. David understood Tier 1 had moved to ADVANCED. Nobody told him the
> design used instant, or why. Reconcile with David first; record his answer in the spec's decisions
> table IN HIS WORDS, with the endpoint and trace_type (lesson L-022).
>
> **Tracerfy's three search types, in David's words: Normal, Advanced, Dossier.** Facts, verified
> 2026-09-21 against the code, the transcripts and `docs/vendor/tracerfy-api.md` (live copy identical):
> - **Normal** is what Tier 1 runs TODAY: `submitSingleTrace` and `submitBulkTrace`
>   (lib/tracerfy/client.ts:85, :716) post to `trace/` with no `trace_type`. 1 credit per lead. Needs
>   names and a mailing address as well as address, city, state.
> - **Advanced** = same batch endpoint, `trace_type: 'advanced'`, 2 credits per lead. Finds the owner
>   from address, city, state; names "not used" (:567). **It still REQUIRES a city (:564).** Batch
>   only: there is NO synchronous Advanced. Built and live-verified 2026-09-15 (3 of 3 hits, 2 credits
>   each) on `feat/tracerfy-advanced-owner-lookup` (worktree `/Users/davidmonroe/PTP-advanced-owner-lookup`,
>   e9940fe + dc7c511). NEVER MERGED.
> - **Dossier** = Property Lookup `property-search/lookup/`, 10 credits per property found. Returns the
>   property, the owner AND the owner's contacts. PTP DISCARDS the contacts (lib/tracerfy/dossier.ts:173)
>   and buys a second lookup; 24 of the 28 saved dossier hits carried phones or emails.
> - The only Tracerfy person path with NO city is the APN lookup `trace/parcel/lookup/` (parcel_id,
>   county, state; 5 credits per hit). The instant lookup `trace/lookup/` (5 credits) needs a city;
>   its `find_owner:true` mode is the synchronous equivalent of Advanced.
> - The whole-batch rejection on one city-less record is PTP's own validator
>   (lib/suite/mcp-tools.ts:359-370), not Tracerfy. Per-record validation fixes it whatever the type.
>
> **How it went wrong.** 2026-09-20 David said "WE ARE NOT USING THE NORMAL TRACE in Tracerfy anymore,
> We are using Advanced or Dossier"; the reply said PTP never used Normal (false). 2026-09-21 the design
> session offered "batch at 1 credit" (Normal) against instant; Advanced was never offered.
>
> **David's intent, his words, 2026-09-21:** "The point of going to Advanced was to remove the need for
> a city, so we could use the APN/property_id lookup." Also: "If no first name or initial send to
> fastappend as an entity" (a trust or name that strips to a surname only). Tier 1 is $0.15 per
> successful trace.
>
> **DAVID'S RULE FOR THE DOSSIER, his words, 2026-09-21:** "The original goal of the Dossier is to test
> for owner is invidual or entity. If individual, tracefy gets the results. If entity, the owner name is
> sent to fastappend for results, it does NOT stay in tracerfy. Tracerfy is NOT to give results for
> entities, ONLY id if is an entity." Verified on this branch: planRoute sends an entity only to
> FASTAPPEND_ENTITY (lib/routing/ownerRoute.ts:379-394) and the dossier parser surfaces no contacts
> (lib/tracerfy/dossier.ts:173, :220). The one Tracerfy-for-entity path, the Tier 1 entity cron's
> salvage submit (main: app/api/cron/sweep-entity-traces/route.ts:503), is removed by d462ab6, which
> is on `feat/contact-vendor-provenance` and NOT on `main`.
>
> **OPEN, for David:** (1) Tier 1 person lookup when there IS a city: Advanced (batch, 2 credits, name
> not sent, results matched back to rows) or instant (5 credits, immediate). With no city, the APN
> lookup either way. (2) Dossier found an INDIVIDUAL owner: use the contacts the dossier already
> returned (paid within its 10 credits, but they carry no name so the owner test cannot run), or a
> second Tracerfy lookup on the owner's name (5 credits, name-matched; what the code does today).
> Entities are settled: FastAppend only.
>
> **State.** Branch `feat/contact-vendor-provenance`. Phase 0 Task 1 committed (1cfb222, dd88bf4),
> Task 2 committed (931929b, NOT reviewed). SDD ledger:
> `.superpowers/sdd/2026-09-21-tier1-phase0-measurement/progress.md` (gitignored). Nothing spent.
> Lessons L-021 and L-022 were earned in this session; read them.

> # AMENDED 2026-09-19. THE DOSSIER NOW HAS TWO LOOKUP KEYS. READ THIS BEFORE THE BLOCK BELOW.
>
> **`main` = `e48d5c7`. 1502 passing / 75 files / 0 failing, `tsc` 0, eslint 47, build compiles.**
> A SEVENTH migration, `20260919_trace_history_parcel_key.sql`, is APPLIED to production and read
> back. Full detail in `History.md`; the lesson is L-020.
>
> **`DOSSIER_APN` had never executed.** It has been emitted by `planRoute` since 2026-09-16, but
> `hasApn()` needs `parcelIdLocal` and `county` and `parcelForFullTrace` set neither, so the
> address key was not the fallback, it was the only key that had ever fired. An MCP caller can now
> supply `apn` and `county` on a record, they persist on `trace_history`, and the tier 2 cron feeds
> them to `parcelForFullTrace`.
>
> **THE KEY IS THREE PARTS: `apn`, `county`, `state`.** `state` was already required and already
> carried, so it completes on its own. Two mutations pin the request shape, and they matter more
> than usual: **the vendor answers a malformed key with a MISS, and a miss is free**, so a two-part
> request would have shipped, found nothing, cost nothing, forever, with no error anywhere.
>
> **DO NOT SAY THE PARCEL ID IS MORE ACCURATE THAN THE ADDRESS.** They fail independently: Napa hit
> on APN and missed on address, Salt Lake did the reverse. It is a second independent attempt, and
> since a miss is free it costs nothing unless it works. Neither is the senior partner.
>
> **SCOPED TO THE MCP SUBMIT.** `v1/trace/bulk` and the dashboard's `trace/bulk` also enqueue tier
> 2 rows and are deliberately NOT wired; either would need a public API field or a CSV column.
> That is a choice, per L-018, not an oversight to helpfully fix.
>
> **WHO ASKED.** The Suite Gateway, which holds a county parcel id for every registry parcel. Its
> side is specced at
> `/Users/davidmonroe/suite-gateway/docs/superpowers/specs/2026-09-19-crm-push-dossier-tier-design.md`
> section 7b, and it fences against shipping before this landed by checking PTP's advertised input
> schema live before sending the field.
>
> **LIVE VERIFICATION RUN AND PASSED**, 2026-09-19, authorised by David, cost $0.20. Napa
> `003330004000`: address mode MISSED and was free, APN mode HIT for 10 credits and returned
> `John Anthony Investments Llc` with all 86 property keys. The APN key resolved a parcel the
> address key could not, through the real wiring. Script kept at
> `tasks/research-scripts/verify-apn-key.ts`; full table in `History.md`.
>
> **GOTCHA THE RUN FOUND, and it will bite the next person who compares identifiers.** The vendor
> returns a DIFFERENTLY FORMATTED apn than the one you send: we sent `003330004000` and got back
> `003-330-004-000`. The situs comes back reformatted too, `1440 FIRST ST` returning as
> `1440 1st St`. **Normalise before comparing any returned identifier against a submitted one**,
> or every correct match reads as a mismatch.
>
> **ALSO NOTE, for anyone reading the block below about the gateway consuming the dossier:** that
> work is live and underway in the suite-gateway repo. PTP's half remains DONE and unchanged, and
> `lib/suite/mcp-tools.ts` still has no HighLevel import and must never gain one.



> # STATE OF PLAY, 2026-09-17. READ THIS BLOCK FIRST.
>
> **This is the ONLY handoff. Do not create a second one.** On 2026-09-16 two documents disagreed
> about priority order and it cost a rework; amend this file instead.
>
> ## Where the work is
>
> **`main`, PUSHED, in sync with origin.** Phases 1 through 4a are live. Numbers live in the
> REVIEW sections at the bottom of `tasks/todo.md`; do not copy them here, they go stale.
>
> | Phase | State |
> |---|---|
> | 1. Dossier client | **DONE** |
> | 2. Never delete a billed row, cache sees paid rows | **DONE** |
> | 3a. plan-aware planRoute, address-only parcels, executor | **DONE** |
> | 3b. Tier 2 bills end to end on the session route | **DONE** |
> | 3c. Pre-submit charge disclosure | **DONE** |
> | 4a. AI Search removed, UI shipped, v1 wired, webhook | **DONE, PUSHED** |
> | 4b. Dossier reaches the CRM | **DONE, PUSHED** |
> | 5a. Export carries everything purchased | **DONE, PUSHED** (`32c29f3`) |
> | 5b. Status is not a receipt; refunds link | **DONE, PUSHED** (`a3752e2`) |
> | 5c. Bulk tier 2 | **DONE, PUSHED** (`4f694e8`). Full Property Trace is complete end to end. |
>
> **AMENDED 2026-09-18, END OF DAY. PHASE 5c IS COMPLETE AND PUSHED. `main` = `4f694e8`, in sync
> with origin, 23 commits.** Baselines: **1306 passing / 67 files / 0 failing**, `tsc` 0,
> eslint 47, build compiles. Final whole-phase review verdict: SHIP.
>
> **WHAT WENT LIVE, and it is a commercial change, not just a feature.** A bulk row arriving with NO
> owner name used to be skipped and free. It is now enqueued, runs a Full Property Trace
> automatically, and is billed **per record SUBMITTED**, so a miss is billed. 273 of 1,270 historical
> bulk rows. **Existing bulk customers now pay for rows that used to be free.** The 2026-09-17 user
> notification covers this explicitly ("we've never charged for it before and we've never explained
> it either"); that gate was checked before push, not assumed.
>
> **A FOURTH MIGRATION IS APPLIED AND VERIFIED**, plus a security one:
> `20260918_property_trace_queue.sql` (the tier 2 queue columns and an all-rungs partial index), and
> `20260918_lock_trace_history_writes.sql`.
>
> **SECURITY, CLOSED 2026-09-18.** `public.trace_history` granted INSERT/UPDATE/DELETE to `anon` AND
> `authenticated` table-wide, so any signed-in user could rewrite `charge` from the browser console.
> It was the KNOWN, deliberately-deferred remainder of the July suite remediation; 5c-2 expired that
> deferral by adding a column the cron claims WORK from, which made it a free-vendor-work exploit.
> Both roles are now SELECT-only, verified with `has_table_privilege` AS ADMIN (never
> `information_schema.role_table_grants`, which is filtered by querying role). See L-014.
>
> **WHAT IS OPEN, all numbered in `tasks/todo.md`, none shipping-blocking:** task 16 (the wallet
> reserve closes back-to-back double-submits but not the sub-second window inside ONE submit; needs a
> transactional hold, i.e. a migration), task 17 (no in-product way to re-run a failed bulk row inside
> the 90-day dedup window, and it now covers the BILLED `no_reach` shape where the customer is out of
> pocket), task 18 (parked cosmetics plus two money residuals judged non-blocking).
>
> **THE NEXT PIECE OF WORK, scoped 2026-09-18 and not started: feed `planRoute` a parcel id.** The
> dossier takes EITHER `apn + county + state` OR `address + city + state`, and the two keys **fail
> independently** (Napa hit on APN and missed on address; Salt Lake did the reverse). `planRoute`
> ALREADY emits both steps and stops at the first hit. Nothing has ever populated `parcelIdLocal`.
> **The ids come from the property-registry, NOT from the customer** — proven by the saved test set in
> `tasks/research-scripts/run-research.ts`, whose rows are registry-shaped (`parcel_id_local`,
> `county`, and a zip comment about what UT counties publish). So this needs no CSV change, no new
> validation and no second dedup key; the row stays keyed on its address. The real unknowns are that
> **PTP has no registry wiring today** (`SUITE_GATEWAY_URL` is configured, no registry call exists in
> `app` or `lib`) and that registry coverage varies by county.
>
> **A THIRD migration is applied to production and verified:**
> `20260917_credit_wallet_balance_trace_link.sql` — `credit_wallet_balance` gained a 5th optional
> `p_trace_history_id` so a refund can name the row it refunds. **Read its header before writing
> any migration**: the first version revoked only FROM PUBLIC and the function came back callable by
> `anon` — a SECURITY DEFINER function that mints wallet balance. Supabase's default privileges
> grant EXECUTE to `anon` and `authenticated` BY NAME at CREATE time and `REVOKE FROM PUBLIC` does
> not touch a named grant. Closed in ~2 min, audited clean. CLAUDE.md's template is corrected.
>
> **AMENDED 2026-09-18, LATER THE SAME DAY. THE THREE HIGHLEVEL BUGS ARE FIXED AND PUSHED.**
> `main` = `bba2966`, in sync with origin, 11 commits. Baselines: **1456 passing / 75 files / 0
> failing**, `tsc` 0, eslint 47, build compiles. 35 mutations (21 implementer, 14 coordinator), all
> killed. A fifth migration, `20260918_highlevel_credential_health.sql`, is APPLIED and read back.
>
> **The list of three was a FLOOR, not a ceiling (L-016). Grepping for the property found six more**,
> and two of them were worse than anything on the list:
>
> - **The duplicate-search step had no `else`.** A failed search left `existingContactId` null and
>   fell through to CREATE, so a credential failure silently made a SECOND copy of a contact the
>   customer already had, and on a partly-broken credential that create SUCCEEDED.
> - **PTP was DELETING customers' HighLevel tags on every update push.** GHL's Update Contact doc
>   states verbatim that the `tags` field "will overwrite all current tags associated with the
>   contact". PTP sent `tags: ['proptracerpro']` on every PUT. In GHL tags drive workflows, so this
>   was silently breaking customers' automation, on a push that reported success. Tags now go on
>   CREATE only. **NOT switched to the additive `POST /contacts/:id/tags`**: its additivity is
>   implied by its name and response shape rather than documented, and swapping verified destruction
>   for unverified behaviour is not a fix. Verify against a real account, then switch.
>
> **THE SCOPE FINDING, and it changes how any future HighLevel error must be read.**
> `contacts.readonly` and `contacts.write` are SEPARATE GHL scopes and PTP's setup copy named only
> "contacts", so a read-only token passed Test Connection and failed every push. Worse: **a missing
> scope returns 401, identical to a revoked token.** Only the response body separates them
> (`Invalid JWT` vs `The token is not authorized for this scope.`), and a wrong location is a 403.
> Three remediations behind two statuses. Never classify a HighLevel failure on status alone.
>
> **THE ORGANISING RULE, which is L-007 pointed at pushes: a 401 is a CREDENTIAL failure, not a trace
> failure.** A credential-class failure now flags the credential, so the five automatic push paths
> (which have no user watching) reach the user on a page they will visit. A record failure (bad
> payload) and a transient failure (rate limit) write NOTHING. And **"not dead" is not "alive"**: a
> batch of only rate limits is no signal, not healthy, because clearing a red badge needs evidence
> the key WORKS.
>
> **THE SAVE POLICY IS NARROWER THAN "REFUSE ANY 401", and David was told.** Refuse on `token` and
> `location`; SAVE WITH A WARNING on `scope`, `transient` and `unknown`. The only check available is
> a contacts READ and every product call is a WRITE, so a `contacts.write`-only token would be
> blocked by a stricter rule. David's stated decision was "refuse on 401/403"; this narrows it on his
> own reasoning for picking that option, which was that a good credential must not be blocked.
>
> # SUPERSEDED BY THE BLOCK BELOW. The amendment that follows was written before David explained
> # WHY PTP must not auto-push, and its headline conclusion is WRONG. Kept only so the correction
> # is legible. Read "PTP DOES NOT PUSH TO THE CRM ON ITS OWN" first.
>
> **AMENDED AGAIN 2026-09-18: FULL PROPERTY TRACE NOW REACHES THE CRM. `main` = `5f45288`, pushed.**
> 1493 passing / 75 files / 0 failing. A SIXTH migration,
> `20260918_trace_highlevel_push_record.sql`, is applied and read back.
>
> **THE GAP I RECORDED ABOVE WAS WRONG THREE WAYS and the corrected version is the useful one.**
> `sweep-business-traces` is TIER 1, so naming it was a misattribution. "Never reaches" was false:
> v1 BULK already pushed tier 2, because it iterates ROWS rather than Tracerfy's batch array. And a
> follow-up guess that a tier 2 single settled via `trace/status` was also wrong: `trace/single`
> settles tier 2 INLINE and `trace/status` returns early on a terminal status.
>
> **ROOT CAUSE, one sentence: push was attached to JOB settlement, which reads Tracerfy's batch
> array, not to ROW settlement.** A settled tier 2 row has `tracerfy_job_id: null`, so every push
> list built that way was blind to it. Fixed by pushing where the ROW settles;
> `sweep-property-traces` alone covers session bulk, v1 bulk AND MCP bulk, since all three enqueue
> into the same queue column.
>
> **THE GUARD THAT PROTECTS A CUSTOMER'S CRM IS `isSuccessful && result` AND BOTH HALVES CARRY
> WEIGHT.** TWO billed-miss shapes carry a NON-NULL `trace_result` with EMPTY phones and emails:
> `property_trace_no_reach`, and a contact-vendor MISS. Under a bare `trace_result != null` both
> push a nameless, contactless contact into the customer's CRM. Never simplify that guard.
>
> **A push is now RECORDED** (`highlevel_contact_id`, `highlevel_pushed_at`,
> `highlevel_push_action` on `trace_history`), so "did this trace reach the CRM" is answerable for
> the first time since January. **It records from now on only:** 2,742 historical traces belonging
> to the six credentialed users stay null, and that must never be rendered as a claim that they did
> not reach the CRM.
>
> **DECIDED BY DAVID: PTP pushes what it settles**, so MCP-submitted tier 2 rows now push even
> though the gateway's `crm_push_owners` also exists. MCP tier 1 still does not push. The asymmetry
> is accepted, not overlooked.
>
> **The Pro gate on the MANUAL push is unchanged, deliberately.** A pay-as-you-go customer pays
> $0.40 for tier 2 against Pro's $0.25 and still cannot use the manual button. David considered
> opening it and decided it stays a Pro benefit.
>
> **STILL OPEN:** a push that FAILED leaves `highlevel_pushed_at` null and nothing re-reads it, so
> there is no automatic retry; the manual job button is the only recovery, and only for Pro. Also open: an entity still pushes
> a garbage contact that SUCCEEDS (`owner_name.split()[0]` as first name); no `highlevel_contact_id`
> is ever persisted so "did this reach the CRM" is unanswerable after the fact; only the first phone
> and first email are ever sent.
>
> **NOT DONE, offered and not taken up:** checking whether any of the 6 live credentials are
> currently dead, which would populate the new flag immediately rather than on their next push. It
> means using customer tokens against HighLevel, so it needs David's go.

**The three live HighLevel bugs below are FIXED as of 2026-09-18. The text is kept as the
diagnosis.**
>
> **Both migrations are APPLIED to production and verified.** `property_record` and `tier` exist
> on `trace_history`; `usage_records.unit_price` default is 0.15.
>
> **Users were notified of the AI Search removal and the pricing change on 2026-09-17.** That was
> the pre-push gate and it is closed.
>
> ## 4b CHANGED SHAPE. The original spec was aimed at the wrong system.
>
> It was specced as: auto-create 65 CONTACT custom fields in each user's GoHighLevel over the API,
> plus a Private Integration Token scope warning. **That was wrong on three counts**, and the
> reasoning is in `tasks/lessons.md` L-010:
>
> - **Most users receive this data through the Suite Gateway**, not PTP's own push. Only 6 of 52
>   PTP users have direct HighLevel credentials configured at all.
> - **The gateway keeps property data on a CUSTOM OBJECT**, `custom_objects.property`, not on the
>   Contact. That object has 50 fields today, read live on 2026-09-17.
> - **Nobody has the permission the auto-create needs.** PTP's own setup page tells users to grant
>   only the `contacts` scope, so no token carries `locations/customFields.write`. And the API
>   cannot create property-object fields at all: `POST /custom-fields/` rejects
>   `custom_objects.property` with "Invalid object key".
>
> **How the gateway actually reads PTP: over MCP, never from PTP's database.** No PTP project ref
> exists anywhere in the gateway repo. The proxy path returns PTP's response verbatim, but
> `crm_push_owners` PARSES it and silently drops every key it does not name.
>
> ## What 4b is now, and what is NOT PTP's job
>
> **PTP's half:** emit the public 65-field record and `tier` on the gateway-facing MCP surface
> (`buildPerRecordResult` and `listTraces` in `lib/suite/mcp-tools.ts`), filtered through
> `toPublicPropertyRecord`. That is the whole PTP change.
>
> **NOT PTP's job, do not build it here:**
> - The 54 new GoHighLevel fields. The list is `tasks/ghl-property-fields-to-add.txt`, generated
>   and checked against the live object. **David creates them in the snapshot template.**
> - Adding those 54 rows to `PROPERTY_FIELD_MIRROR` in the **suite-gateway repo**, and teaching
>   `crm_push_owners` to read `property_record`. Different repo, after the snapshot ships.
>
> **PTP's own direct HighLevel push is being DROPPED, not built.** 6 of 52 users, a permission
> nobody has, and it would put property data on the Contact where the model keeps it on the
> property.
>
> ## Live bugs in PTP's existing HighLevel push, unrelated to tier 2, NOT yet fixed
>
> - **The manual Push to CRM button reports success when the push failed.** The route returns
>   `{success:false}` inside a 200 body and `PushToCrmButton` only checks `response.ok`, so a 401
>   shows a green "Contact created".
> - **A 401 is completely silent on all five automatic push paths.** Nothing reads the returned
>   `{success:false}`; every call site is fire-and-forget into a `console.error`.
> - **Save validates nothing.** A garbage credential saves with a green "Connected" badge; the
>   Test Connection button is separate, optional, never called by save, and only proves a contacts
>   READ.

> # PTP DOES NOT PUSH TO THE CRM ON ITS OWN. 2026-09-19, and it supersedes the block above.
>
> **All EIGHT automatic HighLevel push sites are REMOVED.** `main` = see git, pushed. 1489 passing /
> 75 files / 0 failing, `tsc` 0, eslint 47, build compiles. The test total DROPPED by 4 deliberately:
> 12 old push tests and 5 dead-code tests out, 13 fences in.
>
> **THE REASON, from David, and it is the thing to understand before touching any CRM code.** Most
> PTP users reach their CRM through the **SUITE GATEWAY**, not through PTP. The gateway holds the
> GoHighLevel snapshot and knows the object model: **an entity owner becomes a COMPANY**, a person
> becomes a **CONTACT and only when there is a phone or an email**, and the property hangs on the
> property custom object. **PTP's own push only ever creates Contacts.** So an automatic PTP push
> writes the WRONG OBJECT TYPE into a gateway user's snapshot, and a user with no gateway has no
> snapshot for it to populate correctly either.
>
> **This was ALREADY the decision in this very file** ("PTP's own direct HighLevel push is being
> DROPPED, not built", in the 4b section). It was read and then contradicted by work done on
> 2026-09-18. See L-019: a goal-shaped instruction does not name its mechanism.
>
> **WHAT STILL EXISTS, and it is the whole of PTP's CRM story now:**
> - the **manual** button (`app/api/integrations/highlevel/push/route.ts`), single and bulk. Pro-gated,
>   deliberately: David considered opening it to pay-as-you-go, who pay $0.40 against Pro's $0.25,
>   and decided it stays a Pro benefit.
> - the **CSV export**.
> - **`lib/suite/mcp-tools.ts`, UNTOUCHED and it must stay that way.** When the gateway sends a
>   single or bulk request over MCP, results flow back with NO human step. It has no HighLevel
>   import and must never gain one.
>
> **A trace with nothing to contact is not successful and cannot reach a CRM.** Verified uniformly:
> every path computes `is_successful` as "at least one phone OR at least one email". No path requires
> an owner name, and production has zero successful rows missing one. **Do not change this without
> realising it is a BILLING predicate**: tier 1 bills per successful trace.
>
> **THE REAL WORK, and it is in the suite-gateway repo, not here.** Three links; PTP's is DONE:
> 1. **PTP emits the dossier over MCP.** DONE in 4b: `mcp-tools.ts` sends `property_record`
>    (filtered to 65 defensible keys) and `tier` on both tools.
> 2. **The gateway consumes it.** NOT DONE. `property_record` appears NOWHERE in the suite-gateway
>    source. `PROPERTY_FIELD_MIRROR` in `lib/crm-writer.ts` maps `CuratedProperty` (the registry
>    shape) and has only a handful of entries.
> 3. **The snapshot has somewhere to put it.** DONE and VERIFIED LIVE 2026-09-19 against the snapshot
>    subaccount `jeq20bcKOgy7XQ3AAgHD`: all **54** fields from `tasks/ghl-property-fields-to-add.txt`
>    exist with exact key matches, 104 fields total (50 + 54), types exactly as specced (33 TEXT,
>    19 NUMERICAL, 2 DATE), and **ZERO MONETORY fields**, so nothing created by hand hit the
>    unwritable type. The four renamed mappings (`zip`, `parcel_number_1`, `units`, `years_held`) are
>    present. **Bonus: `original_upb` and `current_upb` now read NUMERICAL**, so the long-standing
>    unwritable-UPB gotcha is resolved ON THIS SNAPSHOT. An account provisioned from an OLDER snapshot
>    still carries the old Money type; a snapshot change does not retrofit.
>
> **CONSEQUENCE NOT TO LOSE:** the credential-health flag (`highlevel_invalid_at/_status/_reason`)
> now updates ONLY when a person acts, via the manual push or save validation. The five unwatched
> paths its design argued for no longer exist. Not broken, but much narrower than the entry above it
> in History claims.

**READ THIS BEFORE TOUCHING OWNER LOOKUP, SKIP TRACE ROUTING, OR PRICING.**
Supersedes `SESSION-HANDOFF-2026-09-15.md` for everything about owner discovery.
That file is still correct on vendor mechanics and its eight defects; this one
overrules its assumption that the AI research step is the path to an owner.

---

## THE ONE THING TO NOT REDO

**The AI research step cannot identify a commercial property owner. This is settled,
measured, and expensive to re-learn.**

- Brave search returned **0 owners across 13 parcels**, twice, with two different query designs.
- It is not a prompt problem or a query problem. **County parcel records are not in any web
  index.** Probed directly: `site:esearch.mobilecopropertytax.com` returns the landing page, the
  cart page and the terms page, and **zero parcel records**. `qpublic.net` and
  `beacon.schneidercorp.com` return only state and county entry pages. Parcel data sits behind
  session state and form POSTs, so no crawler has it.
- The calibration parcel proves it independently: 203 Dauphin St, Mobile AL, whose owner is in a
  free public assessor record we retrieved by hand, returned **nothing** through search.

Do not build another query ladder. Do not add sources. The document is not in the index.

**The working path uses no search step at all.**

---

## WHAT WORKS, WITH MEASURED RATES

Rates reconciled against the Tracerfy and FastAppend **account ledgers**, not documentation.
Hit rates from 24 commercial parcels across OH, CA and UT.

| Step | Endpoint | Cost/hit | Measured |
|---|---|---|---|
| Owner name | `POST tracerfy.com/v1/api/property-search/lookup/` | **$0.20** (10 cr) | **23 of 24** |
| Entity vs individual | regex on the owner name string | **free** | 23 of 23 correct |
| Entity contacts | `POST app.fastappend.com/v1/api/business-trace/lookup/` | **$0.10** (1 cr) | **13 of 22** |
| Individual contacts | `POST tracerfy.com/v1/api/trace/lookup/` `find_owner:false` + name | **$0.10** (5 cr) | 1 of 1 |

**Misses are free on every one of these.** That is why a fallback costs nothing unless it works.

**Commercial means entity: 22 entities, 1 individual, 1 no-owner out of 24 parcels.**

### The dossier has two keys and they fail independently

`property-search/lookup/` takes **either** `apn` + `county` + `state` **or**
`address` + `city` + `state` (+ optional `zip_code`). Mutually exclusive; sending both is a 400.

- Salt Lake `16183060290000` **missed on APN, hit on address**, returning `Colmaven, Llc` — exactly
  what the county recorder shows.
- Napa `003330004000` did the reverse: **hit on APN, missed on address.**

So a prospect with **only street addresses and no parcel ids is a supported case.** `planRoute`
emits both keys when both exist; the caller stops at the first hit.

Address mode also **backfills zip**, which matters because no Utah county publishes one.

---

## WHAT DOES NOT WORK, AND WHY

**`trace/parcel/lookup/` (the 5-credit APN people lookup) is the wrong endpoint for this.**
13 parcels, 11 billed, **0 owner names**. The response shape has no owner field at all. It returns
2 to 5 people, every one flagged `property_owner: false`. It found the business *operator* at the
address, correctly said they are not the owner, and billed $0.10 each time. $1.10 spent, nothing
gained. Note the handoff of 2026-09-15 reports 7 of 12 CA parcels returning a flagged owner from
this endpoint — those were **individually owned**. An entity is not a person and cannot appear in
a consumer-data product.

---

## GOTCHAS THAT WILL BITE. EACH ONE COST REAL MONEY TO FIND.

1. **`corporate_owned` is unreliable.** It returned `false` for `STORAGE TRUST PROPERTIES, L.P.`,
   a Delaware limited partnership (Public Storage). **Classify from the owner name string.**
   `classifyOwnerName()` got it right; the vendor's boolean did not.

2. **`estimated_value === assessed_value` on 23 of 23 parcels, in all three states. There is no
   AVM.** Sale prices in the same records: a parcel with `estimated_value` $203,740 sold for
   $675,000; another at $1,076,990 sold for $7,525,000. Assessed/sale ran **0.07 to 0.59 within
   Ohio alone**, so assessed cannot be scaled to market by any constant.
   **Therefore `estimated_equity`, `equity_percent`, `high_equity` and `free_clear` are unusable.**
   `high_equity: true` occurs exactly when `open_mortgage_balance` is 0 — it means "no mortgage on
   record", not high equity. Never show `estimated_value` as a market value.

3. **`open_mortgage_balance` carries blanket and portfolio debt.** $175,000,000 against a 41,588
   sqft building; $48,000,000 against 46,909 sqft. Use `assessLoan()` in
   `lib/routing/ownerRoute.ts`, which uses **sale price** as the basis and never assessed value.

4. **`property_owner` returned FALSE for a verified owner of record** on an absentee-owned parcel
   — the owner does not live at his own rental. That flag guards fishing without a name. **Once
   you have the owner name, match on the name, not the flag.** Filtering on it discards correct
   answers.

5. **`find_owner: true` misses on absentee owners.** The named lookup (`find_owner: false` plus
   first and last name) hit on the same parcel. Use the named form whenever you have a name.

6. **County owner strings arrive degraded.** Stark County's auditor renders
   `CUTTING EDGE HODINGS LLC` — a typo, missing the L — and Tracerfy's dossier reproduces it
   character for character, which proves the dossier's owner data **is the county assessor roll**.
   Ohio SOS returns **zero** for that spelling. Butler's auditor drops the `, L.P.` suffix
   entirely. Any registry or vendor lookup keyed on the raw county string can fail on spelling.

7. **FastAppend keys on STATE OF REGISTRATION, not the property state.** Confirmed on the vendor's
   own product page: *"At minimum we need business name and state of registration."* The API
   reference never defines the field, which is why nobody caught it. PTP sends the **property**
   state. It worked **13 of 22 times**. NOTE: this was NOT the cause of the misses we tested —
   `STORAGE TRUST PROPERTIES` missed on OH, on DE, and on its full legal name plus DE. FastAppend
   simply does not have it.

8. **FastAppend coverage is per-entity random, not geographic.** An early 0-of-4 in Ohio looked
   structural and was a four-parcel sample. A 12-parcel, 4-county Ohio retest returned **8 of 12**,
   with the smallest county going 3 for 3 and both large counties 2 for 3. Combined Ohio is 8 of 16.

9. **`role` and `is_registered_agent` are documented response fields and PTP reads neither.**
   They return `MEMBER`, `MANAGER`, `GENERAL PARTNER`, `REGISTERED AGENT`, and combinations.
   A registered agent is a service of process, **not necessarily a principal.** This is the cause
   of defect 3 in the previous handoff (204 of 496 hits mapping one person to 2+ entities, one
   person to 42, five contacts literally named "Secretary of State"). Reading the flag is free.

10. **A synchronous FastAppend endpoint exists** (`business-trace/lookup/`, 1 credit, misses free,
    500/min). PTP calls the **bulk** endpoint and polls. That is the cause of defect 4.

11. **Bulk: the dossier has NO bulk endpoint.** Docs: *"one address in, one address out."* No
    array, no CSV. But the rate limit is **500/min**, so 150 parcels is a ~20 second loop.
    FastAppend `business-trace/lookup/` **does** take an array of up to 15. `/execute/` is a
    filter-based list builder (up to 25,000 rows), not a way to submit a list of specific APNs.

12. **Tracerfy bills the dossier as "Single-Address Lookup"** on the dashboard, even in APN mode.
    If you audit spend by line item it will not appear under anything resembling the endpoint name.

---

## PRICING, AS DECIDED

### CANONICAL TABLE. David settled this on 2026-09-16 after three restatements.

**TWO axes: tier and plan. FOUR numbers. If your table has more or fewer cells than four, it is
wrong.**

| Tier | When | Model | Pro + AcquisitionPRO | Pay-as-you-go |
|---|---|---|---|---|
| 1 | Owner of record is **known** | per **successful trace** | **$0.15** | **$0.25** |
| 2 | Owner **not** known, OR the caller wants the enriched dossier | per **record** | **$0.25** | **$0.40** |

**Owner type does NOT affect price. It selects the vendor.** An individual routes to Tracerfy, an
entity routes to FastAppend, and both bill the same tier 1 rate for that plan. There is no
entity price, no entity surcharge and no entity discount anywhere in the model.

**Tier 2 does not split by owner type either.** Once the owner is unknown, or the caller wants the
dossier, the price is the same for an individual and an entity.

**The trap that cost three restatements:** the vendor split (Tracerfy vs FastAppend) and the
vendor COSTS ($0.10 entity contacts, $0.10 individual contacts, $0.20 dossier) are real and are
documented above in WHAT WORKS. They are cost-side only. Do not let them leak into the price
table. `CHARGE_PER_FASTAPPEND_SUCCESS` existed because the old model priced the FastAppend path
separately; under this model that is retired and an entity trace bills the plan's tier 1 rate.

**Tier 2 blended cost is about $0.25 per record**, which is why the Pro tier-2 rate of $0.25 runs
at cost. **That is intentional**; David covers it from membership revenue outside PTP. Do not
raise it and do not flag it again.

**Costs, for margin checks:** FastAppend entity contacts $0.10/hit. Tracerfy individual contacts
$0.10/hit. Dossier $0.20/hit. Tier 2 blended cost is about $0.25 per parcel analyzed, which is why
the Pro tier-2 rate of $0.25 runs at cost. **That is intentional**; David covers it from membership
revenue outside PTP. Do not raise it and do not flag it again.

### The superseded version, kept only so nobody restores it

| Tier | When | Model | Price |
|---|---|---|---|
| 1 | Owner already in the registry | per **successful trace** | **$0.15** |
| 2 | Owner absent, OR the caller wants the enriched dossier | per **record** submitted | **$0.40** |

Per 100 tier-2 records: **$40 revenue** against ~$25 cost (96 dossier hits at $0.20, ~54 FastAppend
hits at $0.10, ~4 individuals at $0.10) = **about 37% margin**.

$0.25 was modelled first and came out at **exactly zero margin**, because the $0.20 dossier is
sunk on every hit regardless of whether the contact step later succeeds. Encoded in
`PRICE` in `lib/routing/ownerRoute.ts`.

**Structural note:** under per-record pricing a *better* FastAppend hit rate *reduces* margin,
because revenue is fixed and each hit costs $0.10. Success is a cost.

---

## THE DOSSIER RETURNS 86 FIELDS. WE USE THREE.

### MEASURED FIELD INVENTORY. Re-derived 2026-09-16 by counting keys in the 24 unique saved raw responses.

This is the empirical answer to "is 60+ fields a defensible claim". **It is.**

| | Count |
|---|---|
| Keys returned on `response.property` | **86** |
| Forbidden to display (AVM, equity, `corporate_owned`, `price_per_sqft`) | 7 |
| Propensity and renovation scores (built on the equity math) | 15 |
| Never once populated across all 24 | 18 |
| **Fields with at least one usable value** | **46** |

Plus `owners`, `mailing_address`, `contacts` and `meta` as sibling objects on the same response.

**So "60+ fields" is accurate for what is RETURNED and is conservative against 86.** It is NOT
accurate as a claim about what is reliably populated. David's framing is the correct one: the
fields are there, and which ones are useful depends on the market, the county and the state.
Copy should state the count and then band by reliability. Never promise a field flat.

**Usable-rate bands, measured, not assumed:**

- **100%** (16): `address`, `city`, `state`, `zip_code`, `county`, `latitude`, `longitude`, `apn`,
  `property_type`, `property_use`, `land_use`, `lot_size_sqft`, `assessed_value`,
  `absentee_owner`, `area_median_income`, `investor_buyer`
- **75-99%** (5): `building_size_sqft` 91, `last_sale_date` 82, `years_owned` 82,
  `document_type` 82, `recording_date` 82
- **50-74%** (6): `year_built`, `open_mortgage_balance`, `lender_name`,
  `estimated_mortgage_payment`, `flood_zone`, `stories`
- **25-49%** (6): `units_count`, `prior_sale_date`, `total_properties_owned`,
  `total_portfolio_value`, `last_sale_price`, `cash_buyer`
- **1-24%** (10): MLS fields, `beds`, `has_ac`, `has_garage`, `roof_construction`,
  `prior_sale_price`, `quit_claim`

**Fields nobody had documented that matter for CRE:** `years_owned` (82%, hold-period signal),
`total_properties_owned` and `total_portfolio_value` (36%, portfolio-scale signal),
`flood_zone` (64%), `area_median_income` (100%), `investor_buyer` (100%).

**Note on the band numbers:** these are computed over the 24 unique records and differ slightly
from the per-field rates below, which were measured over a 23-hit subset. Where they disagree,
prefer these, because they are reproducible from the saved files.

---

### DECIDED 2026-09-16: STORE PER-USER IN PTP. NEVER PROPAGATE TO THE PROPERTY-REGISTRY.

David: *"PTP has a supabase database, so I see the new fields being added and saved for the user.
What I don't want it to do is update the property-registry from the results."*

So the original line below is correct and stands. **The boundary is not storage, it is direction:**

- **ALLOWED:** dossier fields persisted in PTP's own Supabase (`rmmwkjmjchpfebxroyoo`), scoped to
  the user who paid for them. They bought it, it is theirs, it shows up in their account.
- **FORBIDDEN:** any write from PTP results into the shared **property-registry**. Not a backfill,
  not an enrichment job, not "while we're here". Purchased per-user data must not become a shared
  asset.

**Why, so nobody helpfully reverses it later.** Two reasons and both matter. It is the paying
user's data, not PTP's inventory to resell. And the registry's whole value is that it is
county-sourced with provenance; injecting vendor dossier fields would break that claim silently,
and a registry row whose origin is "a customer's Tracerfy purchase" cannot be told apart from a
county-sourced one after the fact.

**Verified 2026-09-16: no such path exists today.** PTP constructs exactly one Supabase client
(`lib/supabase/admin.ts`), pointed at its own project. The only `property-registry` mentions in the
codebase are prose comments in `lib/utils/address-normalizer.ts:75` and `lib/suite/mcp-tools.ts:85`
explaining why ZIP became optional. The `SUITE_GATEWAY_*` env vars are for reading entitlements,
not for writing parcels. **If this ever gets built it will be built in the gateway or in a
registry-side job, not here, so the guard has to live there too.**

### OPEN ITEM 8 IS CLOSED. Read 2026-09-17 from the actual terms, not inferred.

Source: `https://tracerfy.com/privacy-policy`, sections 4.7 and 4.8. **Storing results per-user is
permitted. Do not raise it again.**

- **4.7, ownership:** *"You retain all ownership rights to data you upload to Tracerfy. We claim no
  ownership or intellectual property rights over your uploaded data."*
- **4.8, the actual restriction:** *"Service results may not be resold or redistributed as a
  standalone data feed, database, directory, or sublicensed product."* Permitted uses are
  *"lawful skip-tracing, contact-enrichment, direct mail, real estate, debt collection,
  business-to-business enrichment, and related internal business workflows only."*

PTP storing a user's purchased record for that user's own workflow is contact-enrichment and an
internal business workflow. Explicitly allowed. **What 4.8 prohibits is exactly what David ruled
out on his own: turning results into a standalone database.** That is the property-registry
propagation banned above. The instinct and the contract agree.

### THE REAL EXPOSURE, and it is not storage: FCRA PERMISSIBLE USE IS NOT PASSED THROUGH.

**4.8 also states:** *"Service results may not be used for employment, tenant screening, credit,
insurance, eligibility, adverse-action, harassment, stalking, or any FCRA-regulated purpose."*

Tracerfy binds PTP to that. **PTP does not bind its own users to it.** Verified 2026-09-17: no FCRA
language, no permissible-use notice, and no acceptable-use or terms route anywhere in `app/`,
`components/`, `lib/` or `docs/`. Zero matches.

PTP resells access to this data to real-estate customers, and **tenant screening is a thing a
landlord will plausibly try**, so the prohibited use sits directly adjacent to the customer base.
The obligation does not stop at PTP; it has to reach the end user running the search.

**Not a blocker for tier 2 and not a technical fix.** It is a terms-and-surface question: whether
the restriction appears at signup, in the API docs, in the MCP caveat, or on a terms page that does
not currently exist.

### DECIDED 2026-09-17: THE CHARGE FOLLOWS THE VENDOR CALL, NOT THE CALENDAR.

David: *"If a rerun pulls from Tracerfy and not the database, they get charged."*

**The rule is mechanical, which is why it cannot drift:** if serving the request spends money at
Tracerfy, the user is charged. If it is served from the user's own stored record, it is free.
There is no separate cache policy to keep in sync with billing, because the two are the same
condition.

Consequences, all of which fall out rather than needing decisions:

- **The 90-day promise at `LandingPage.tsx:378` HOLDS for tier 2**, provided the record was stored.
  No copy change needed.
- **The cache is PER-USER, and that is required, not incidental.** `trace_history` is already keyed
  `UNIQUE(user_id, address_hash)`, so this needs no schema change. Two different users tracing the
  same parcel BOTH pay, because serving user B from user A's purchase would be redistributing one
  customer's data to another. That is the same boundary that bans registry propagation, and it is
  the thing 4.8 prohibits. **Do not "optimise" this into a shared cache. It is the product rule.**
- **"Clear cache and re-run" correctly charges**, because it forces a fresh vendor call by
  definition. The existing button at `trace/single/page.tsx` already warns about a charge.
- A record whose dossier was never captured is a cache MISS and re-buys, which is correct.

### DECIDED 2026-09-17: AI SEARCH IS REMOVED. Tier 2 ships as a NAMED FEATURE.

David: *"We no longer need AISearch, so remove it. Add in Property Enrichment, unless you can think
of a better name."*

This **reverses** the earlier "replace in place" decision, which was my recommendation and was
wrong. I recommended it before reading what `AIResearchResult` actually was: a stored-and-returned
contract across two public routes, two webhook payloads, the CSV export, the MCP surface and the
results card, with no room for an 86-field property record. David accepted the recommendation on
my say-so. Removal is the cleaner answer and it is now the plan.

**FOR THE MARKETING PAGES, WHENEVER THEY ARE NEXT TOUCHED:** this feature needs a **full dedicated
section**, not a bullet. It is the entire justification for the tier 2 price and the landing page
currently says nothing about it. See the tier 2 value copy already written into
`LandingPage.tsx:370` as a starting point, and the measured field inventory above for what may
honestly be claimed. Do not promise the distress flags; nine of eleven are true zero times.

### THE NAME IS "FULL PROPERTY TRACE". Decided by David 2026-09-17. Use it everywhere.

Nothing customer-facing says "AI Search" or "AI research" after this ships: UI, API docs, MCP tool
descriptions, pricing page, user notification.

**Removal is a HARD REMOVE, no deprecation window.** David's reasoning, worth keeping because it
is the one-line pitch for the feature: *"It was only used if there was no owner, so an owner could
be traced. Tier 2 fixes that with better results and returns more fields."*

Measured against the live DB 2026-09-17 before deciding: AI Search carried **1,301** rows across
**11 users**, found an owner **68%** of the time, charged 743 times for **$111.45**, last used
2026-09-14. **Nothing was in flight**, so the removal strands no work. `api_logs` holds 0 rows
despite a writer at `lib/api/auth.ts:108`, so there is no usage visibility on the public v1 API at
all. Full Property Trace hits 23 of 24 by comparison, so those 11 users get a materially better
product at a higher price. **Say that in the notification rather than announcing an increase.**

The reasoning behind the name, recorded so it is not re-argued:

- PTP's entire vocabulary is *trace*. The product is PropTracer, the verb is trace, the unit is a
  trace. "Enrichment" introduces a second noun users must learn and map onto the first.
- "Property Enrichment" implies you already HAVE the property and are improving it. That fits the
  opt-in case and misses the primary one, which is *I do not know who owns this*. Per the pricing
  table the dominant trigger is an ABSENT owner, so the name should not presume you have anything.
- "Full" contrasts cleanly with the basic trace and maps to the tier 1 / tier 2 split without
  exposing the word "tier" to customers.

Either name is workable. **The decision is David's; this is a recommendation only.** Whatever is
chosen must be used consistently in the UI, the API docs, the MCP tool descriptions, the pricing
page and the user notification, all of which currently say "AI Search" or "AI research".

### DECIDED 2026-09-17: A DOSSIER MISS IS STILL BILLED. "Per record submitted" is literal.

Two different misses had been conflated and only one had ever been decided:

| Case | We spend | Customer receives | Billed? |
|---|---|---|---|
| Dossier HITS, contact step finds nothing | $0.20 | the 86-field property record | **YES**, always was |
| Dossier MISSES, no parcel found at all | **$0.00** (misses are free) | **nothing** | **YES** — David, 2026-09-17 |

David chose to bill the second case too. It matches the handoff's margin table, which bills 100
records against 96 dossier hits, and it matches the notification copy he has already approved:
*"you are charged per record you send us, whether or not contacts come back."*

**The consequence to design around: a customer can submit a record, receive literally nothing, and
be charged.** That is legitimate under this model but it MUST be disclosed BEFORE the charge, not
discovered after. The existing AI Search confirm dialog says *"You will be charged $0.15 if an
owner is found"* — tier 2 needs the inverse sentence. **Phase 4 UI requirement, not optional.**

**OPEN, and it follows mechanically from this decision: is a repeated miss charged every time?**
David's rule is *"if a rerun pulls from Tracerfy and not the database, they get charged."* A
re-submit after a miss has no stored record to serve, so it does pull from Tracerfy, so by that
rule it charges again. A customer with a bad address could pay four times for four nothings.

**AGREED by David 2026-09-17: the MISS IS CACHED.** A re-submit inside the 90-day window is free.
It costs nothing (the vendor charges us nothing for a miss either way), it closes the only path
where a customer can be billed repeatedly for the same absence, and it stays inside David's rule
because the answer is then served from the database rather than from Tracerfy.

**Implementation, and it is smaller than it sounds.** A billed tier-2 miss is a row with
`tier = 2`, `charge > 0`, `property_record IS NULL`, `status = 'no_match'`. Two consequences:

- **`CACHE_HIT_FILTER` in `lib/trace/billedRows.ts` must gain a third arm.** Today it is
  `is_successful.eq.true,property_record.not.is.null`, and a tier-2 miss row matches NEITHER, so
  it would re-buy. It needs the equivalent of `(tier = 2 AND charge > 0)`: **a billed tier-2 row
  is served from the database whatever it contains.** That IS David's rule stated exactly.
- **The delete guard already covers it, no change needed.** `isBilledRow` returns true on
  `charge > 0`, so a billed miss row is already protected from all ten delete sites.

**After 90 days it re-buys, which is correct**, not a loophole: county records change, and an
address with no parcel today may have one next year.

### RATE LIMIT CORRECTION, same source, read 2026-09-17.

The handoff's **500/min for the dossier is CORRECT**, but incomplete in a way that matters for
tier 2 bulk design. Verbatim from `https://www.tracerfy.com/skip-tracing-api-documentation/`:

> *"Instant Trace, Enhanced Trace, Phone Verification, APN Instant Lookup & Property Lookup — 500
> lookups per minute (shared counter)"*

**It is a SHARED counter.** `property-search/lookup/` (the dossier) and the instant person trace
draw from the same 500/min pool. A tier 2 bulk run does a dossier call AND then a contact call per
parcel, so a 150-parcel run consumes roughly 300 of that shared budget, not 150. Size the loop
against the shared pool.

Also note the batch endpoints are far tighter and are a different limit entirely:
*"Batch Trace & APN Batch Trace — 10 submissions per 5 minutes"*. A generic abuse-policy line on
the same page ("Maximum rate limit is 10 POST trace requests per 5-minute window") refers to those
batch submissions, NOT to the instant endpoints. Do not read it as a 2/min global cap.

---

Worth capturing per-user (the user bought it, for their own use — this is NOT a shared registry).
Fill rates below treat **0 as absent**, measured over 23 hits.

**Trustworthy** — county-sourced facts and observations:
`lot_size_sqft` 100%, `assessed_value` 100% (label it assessed, never market), `latitude`/
`longitude` 100%, `property_type`/`property_use`/`land_use` 100%, `building_size_sqft` **91%**,
`year_built` 78%, `stories` 70%, `units_count` 43%, normalized `apn` 100%.

> **CORRECTION, 2026-09-16, re-derived from the 24 saved raw responses in `tasks/research-test/`.**
> An earlier version of this line said "every status flag at 100%". **That was a PRESENCE count and
> it is misleading.** The flag keys are present on 24 of 24 records. What they actually contain:
>
> | Flag | Present | Actually TRUE | |
> |---|---|---|---|
> | `absentee_owner` | 24/24 | **21 (88%)** | genuinely useful, the one worth surfacing |
> | `owner_occupied` | 24/24 | 1 (4%) | |
> | `vacant`, `tax_delinquent`, `tax_lien`, `pre_foreclosure`, `foreclosure`, `inherited`, `death`, `judgment`, `hoa` | 24/24 | **0 (0%)** | never fired once |
>
> Nine of the eleven flags have **never been true on a commercial parcel in this sample.** Whether
> that is because commercial property genuinely is not distressed, or because the vendor does not
> populate distress flags for commercial, is UNKNOWN and 24 records cannot settle it.
>
> **Do not advertise the distress flags as a reason to buy.** `absentee_owner` is the only one
> with evidence behind it. This is the exact presence-versus-usable error this document's own
> closing warning names, committed inside this document.

**Transaction and debt layer** (bank debt — Maturr covers CMBS/HUD/Ginnie, not this):
`last_sale_price` **52%** (Ohio-only in our sample), `last_sale_date` / `recording_date` /
`document_type` ~91% of those, `open_mortgage_balance` 70%, `estimated_mortgage_payment` 70%,
`lender_name` 74%.

### CAPTURE EVERYTHING. GATE DISPLAY, NOT STORAGE. Revised 2026-09-16 on David's challenge.

An earlier version of this section said "do NOT store or display" for three groups at once. David
pushed back: a field that is empty in 24 parcels across OH, CA and UT may be populated in other
counties, and blocking storage on a 24-parcel sample is the L-001 mistake. He is right. **Nothing
is blocked from STORAGE.** The rules below govern DISPLAY only, and each one names its reason,
because the reasons are not the same and they do not age the same way.

**Group A, SIX fields. Do not DISPLAY or EXPORT. Reason: provably wrong, not missing.**
`estimated_value` (100% populated, but it equals `assessed_value` on 23 of 23; there is no AVM),
and everything derived from it: `estimated_equity` (46%), `equity_percent` (46%), `high_equity`
(33%), `free_clear` (33%). Plus `corporate_owned` (92% populated but returned FALSE for
`STORAGE TRUST PROPERTIES, L.P.`).
**More counties will not fix these.** The defect is in the vendor's math, not in county coverage.
Store them; if the vendor ever ships a real AVM the history is there.

> **`price_per_sqft` WAS in this group and was MOVED OUT, 2026-09-17.** It does not belong here.
> Measured against every parcel carrying both inputs, it is `last_sale_price ÷ building_size_sqft`
> and has nothing to do with assessed value: 64 vs a sale/sqft of 64.43 where assessed/sqft was
> 19.45; 370 vs 369.98 where assessed was 169.76; 349 vs 348.88 where assessed was 58.14.
>
> It was blocked on a REDUNDANCY argument (derivable from two exported columns), not a correctness
> one, and this document filed it alongside six fields that are genuinely wrong. **The two
> arguments are not the same and must not be merged.** It is now EXPORTED, with its 0 rendered
> BLANK: it reads 0 on 9 of 12 parcels and every one of those is "no sale price on record", so a
> 0 in that column would be fabricated data, not a measurement.

**Group B, 15 propensity fields. The blanket ban was TOO BROAD. Two separate problems:**

1. *Equity contamination, varies by model.* The `_factors` arrays name every input with points.
   `refi_propensity` is almost entirely equity math: `thin_equity` -15 (fires 14/24),
   `high_equity` +15, `free_clear` +6, `ltv_sweet_spot`. That one is genuinely unusable.
   `sell_propensity` is MIXED: only `low_equity_distress` +10 and `free_clear` +4 are tainted,
   while `absentee_owner` +8 (21/24), `investor_buyer` +5 (21/24), `portfolio_size` up to +5,
   `years_owned` up to +12, `quit_claim_deed` +4, `mls_cancelled` +15 and `aging_property` are
   real, independently checkable signals.
2. *They are RESIDENTIAL models run on commercial buildings.* Verbatim from the factors:
   `"41,588 sqft — large home, higher HVAC cost and complexity"` on the building the handoff
   elsewhere records as carrying $175,000,000 of blanket debt. Also `"79,684 sqft — large home"`,
   `"Home built in 1904 (122 years old)"`, and `home_value` scoring off `estimated_value`.
   The roof, HVAC and solar models are homeowner models. They are not wrong about equity so much
   as inapplicable to the asset class.

   **`sell_propensity` also consumes `corporate_owned` (+3, fires 22/24), a field this document
   already flags as unreliable.** And `low_equity_distress` fires on 14 of 24 at +10 points, off
   an equity number computed from assessed value, where assessed/sale ran 0.07 to 0.59 in Ohio
   alone. So the sell score is being inflated on more than half the sample by a signal that is
   wrong by construction.

   **Do not display the scores. DO mine the `_factors` arrays**, which surface `years_owned`,
   `portfolio_size`, `flood_zone`, `absentee_owner` and `quit_claim` as raw signals. Surface those
   from the underlying fields directly, where they are checkable.

**Group C, 18 fields never populated in this sample. NOT BLOCKED. Coverage, not correctness.**
`tax_delinquent`, `tax_delinquent_year`, `tax_lien`, `foreclosure`, `pre_foreclosure`, `inherited`,
`death`, `judgment`, `vacant`, `hoa`, `adjustable_rate`, `subdivision`, `mls_active`,
`mls_pending`, `mls_sold`, `baths`, `has_pool`, `has_deck`.

These are absent in 24 parcels across three states. **That is a statement about OH, CA and UT, not
about the field.** Several are exactly the distress signals a CRE prospector wants, and county
recorders differ enormously in what they publish. Capture all of them, display them when present,
and do not ADVERTISE them until a wider sample shows a rate. The only honest current statement is
"not observed in the 24 parcels measured."

Always empty on commercial: `subdivision`, `tax_delinquent_year`. Residential-only fields
(`beds`, `baths`, `roof_material`) fill under 10%.

**Registry gaps this fills:** no Ohio county publishes `building_area`, `sqft_building` or
`assessed_value` — the registry refuses the filter outright. The dossier supplies both.

---

## STATE OF THE CODE

### Committed, NOT pushed
- Branch **`feat/owner-routing-tiers`**, commit **`40ea107`**, off `main`.
- `lib/routing/ownerRoute.ts` — `classifyOwnerName()`, `assessLoan()`, `planRoute()`. Pure
  decision logic, no I/O. **Nothing calls it yet.**
- `lib/routing/__tests__/ownerRoute.test.ts` — **63 tests, 5 mutations verified red**,
  `tsc --noEmit` clean, lint unchanged from baseline.
- Push is held deliberately: David needs to notify existing users first.

### Uncommitted, in a separate worktree
- **`/Users/davidmonroe/PTP-owner-extraction-fix`**, branch `fix/no-tenant-as-owner`,
  HEAD still `96178fe`, three modified files, **244 tests passing**, reviewed twice.
- It replaces the absolute "a business operating at an address is NEVER the owner" rule with an
  evidence-gated one. **That absolute rule was wrong** — owner-occupancy is real (the branch's own
  canonical test fixture, 203 Dauphin St Mobile AL, is a property where the restaurant operator
  owns the building, verified at the county). See `tasks/lessons.md` L-001.
- **Decide separately.** It guards the `researchProperty` path, which this session's findings say
  does not belong in the owner-lookup flow at all. It is safe where it sits.

### Also uncommitted
- `/Users/davidmonroe/PTP-advanced-owner-lookup`, branch `feat/tracerfy-advanced-owner-lookup`,
  commits `e9940fe` + `dc7c511`, 211 tests. Untouched this session.

---

## OPEN, IN PRIORITY ORDER

1. **UI and marketing pages** still advertise the old pricing and the search step.
   `components/landing/LandingPage.tsx` advertises $0.07/$0.11 in **nine** places. This is a hard
   merge blocker and it deploys with the app. **Next session's main task.**
2. **Notify existing users** of the pricing change before the push. David's task.
3. **Nothing is wired to a route.** `planRoute()` returns a plan; no caller executes it.
4. **Registration state is unresolved.** Every entity call sends the property state. Resolving it
   needs a Secretary of State step, which is browser-reachable and crawler-hostile — Ohio SOS
   returns 403 to `curl` and both registries sit behind Cloudflare.
5. **Dossier field capture is not built.** 84 fields bought per record, 3 used.
6. **Pre-flight balance check for bulk.** `parcels × 10 credits` against the Tracerfy balance
   before the first call, plus the user's PTP wallet. Without it a bulk run truncates mid-job, and
   previous-handoff defect 2 (a recorded charge on a failed wallet deduct) does damage there.
7. **`PRICING.COST_PER_RECORD` is $0.009** and contradicts the verified $0.02/credit. Written at
   14 sites, read at none. Left alone to keep the diff minimal.
8. **Tracerfy terms of service** on storing dossier fields per-user. Not a technical question.

---

## BALANCES AND SPEND

- Tracerfy: **10,744 credits** at $0.0200/credit (David topped up mid-session).
  This session used 340 credits = $6.80.
- FastAppend: **1,086 business credits** at $0.10/hit. This session used 13 = $1.30.
- Brave + Anthropic on the dead search path: **$0.22**.
- **Total session spend: $8.32.**

---

## WHERE THINGS LIVE

- **Research scripts:** `tasks/research-scripts/` — committed, with a README mapping each script
  to what it proved and what it cost. Preserved deliberately because the previous session's
  harness lived only in a session-scoped scratchpad and was lost.
- **Raw vendor responses:** `tasks/research-test/` — **gitignored**. Holds purchased skip-trace
  PII for 63 real individuals (DOBs, phones, emails). On disk for David's use, never in git.
- **Lessons:** `tasks/lessons.md` — L-001 through L-004. L-004 is about repeated scope drift and
  is worth reading before starting.
- **Review section:** bottom of `tasks/todo.md`.
- **Vendor docs, saved locally:** the Tracerfy markdown export and the FastAppend API docs HTML
  were fetched into the session scratchpad and will be lost. Re-fetch from
  `https://tracerfy.com/skip-tracing-api-documentation/download.md` and
  `https://app.fastappend.com/api-docs/` if needed.

---

## CHECK THE ARITHMETIC AGAINST THE ITEMS BEFORE RELAYING ANY COUNT.

This session produced three reporting errors that were caught only by re-deriving from raw data:
field fill rates computed from **presence instead of usable values** (reported 100% for fields
that were 52% and 43%), a **0-of-4 sample read as a structural conclusion** about Ohio, and a
**"the padding row doubles the bill"** claim that both vendor ledgers disproved. Verify before
asserting, and prefer the live ledger over any document, including this one.
