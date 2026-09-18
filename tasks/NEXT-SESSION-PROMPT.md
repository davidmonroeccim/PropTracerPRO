We're building PropTracerPRO's "Full Property Trace" (tier 2). Phases 1 through 5b are DONE,
COMMITTED AND PUSHED. main is at a3752e2 and in sync with origin. All three migrations are applied
to production and verified. Phase 5c is next and it is the last one.

Read first, in this order:
  /Users/davidmonroe/PropTracerPRO/tasks/SESSION-HANDOFF-2026-09-16.md
    Start with the STATE OF PLAY block at the very top, amended 2026-09-18. It is the only handoff;
    do not create a second one. Two disagreeing documents cost a rework on 09-16. It carries the
    phase table, the pricing table, the vendor gotchas and the three live HighLevel bugs.
  /Users/davidmonroe/PropTracerPRO/tasks/todo.md
    The LAST section is "PLAN: Phase 5c (2026-09-18)". That is your spec. Everything below is a
    summary of it, not a replacement for it.
  /Users/davidmonroe/PropTracerPRO/tasks/lessons.md
    L-007 through L-012. L-009 and L-012 especially: both are about verification that looks like it
    worked and did not.
  /Users/davidmonroe/PropTracerPRO/History.md for the dated narrative.

Everything measured is already in those files with the evidence attached. Do not re-derive it.
Pricing is SETTLED: four numbers, tier 1 is $0.15 Pro/AcquisitionPRO and $0.25 pay-as-you-go,
tier 2 is $0.25 and $0.40. Owner type selects the VENDOR, never the price. Do not reopen it.

BASELINES, verify against these:
  npx vitest run                  1000 passing, 61 files, 0 failing
  npx tsc --noEmit                0 errors
  npx eslint app lib components   47 problems
  npm run build                   must compile
Do NOT run bare `npm run lint`; it scans untracked worktrees and reports ~10,365.
Run the real build before any push. A green suite and a clean typecheck are NOT a build.

PHASE 5C, THE WORK. Three sub-phases, STOP AND CHECK IN AFTER EACH.

  5c-1, PREREQUISITES. Two live defects; bulk tier 2 on today's client is broken without them.
   - A FastAppend "company not found" is HTTP 404 with a body saying `hit:false`. That is a MISS.
     lib/tracerfy/client.ts:536 checks `if (!response.ok)` and returns contactFailure BEFORE the
     body is parsed, so executeRoute sets pass2.failure and the route 502s with charge 0. A record
     whose dossier HIT ($0.20 spent, the 86-field record in hand) is thrown away unbilled. Measured
     rates make this ~9 in 22 entity records. L-008 recorded this lesson and the fix landed one
     layer too deep. Discriminate on the BODY, not the status. Tracerfy's person endpoint is fine.
   - getAnalytics()'s type is fiction. It declares credits_remaining/credits_used/total_jobs/
     total_records; the API returns balance/total_queues/properties_traced/queues_pending/
     queues_completed. Zero call sites, so nobody found out. A guard on the declared field compares
     `undefined < 300`, which is false, so it blocks nothing while looking implemented.

  5c-2, THE ENGINE. Visible: almost nothing. Say so bluntly rather than dressing it up.
   Queue plus cron worker; it cannot run in a 60s submit route. Own queue columns, NOT
   ai_research_status (VARCHAR(20), named for a retired engine, and its partial index covers only
   the literal first rung so today's retries are seq scans). Mirror the entity cron's atomic
   compare-and-swap claim exactly. 120 records per run at concurrency 5 = 48% of the shared 500/min
   pool. Billing follows L-007: bill on whether the dossier ANSWERED, never on whether it FOUND
   anything; a vendor failure is not billable and goes back on the retry ladder.

  5c-3, THE SURFACES. Visible: all of it. This is the phase David judges.
   Both pre-flight checks, all three submit estimates, and every user-facing string that goes false.
   The plan enumerates them with line numbers so none is missed.

FOUR THINGS PHASE 5C MUST NOT FORGET:
  - THE CAP IS 500 RECORDS, decided 2026-09-18. MAX_RECORDS drops from 10,000 to 500 on session and
    v1; MCP already caps at 500, so this makes one number true on all three surfaces. Measured
    against all 92 historical jobs: median 20, p95 223, max 654, and exactly one job exceeds 500.
  - STATUS IS NOT A RECEIPT. That is phase 5b's rule and it arrives again here.
    lib/trace/entityTraceAttempts.ts says an exhausted row is written terminal with no charge
    "which is also what keeps it deletable". Under tier 2 a row can be exhausted AND billed.
    Exhaustion must never zero a receipt. Use foldBillingWrite; never a flat write.
  - THE TWO BALANCE CHECKS ARE DIFFERENT AND MUST NEVER BE MERGED. The user's PTP wallet (dollars)
    answers "can the customer pay" and fails with a 402 telling them to add funds. PTP's Tracerfy
    balance (credits, 10,694 live, SHARED across all users) answers "can PTP execute" and must
    NEVER tell a customer to add funds. Size it against credits needed PLUS what is already queued.
  - BulkSkipSummary's premise is gone. Its header says "There is no price here and there must never
    be one. These rows are free." Blank-owner rows are no longer free. So is PTP_MCP_CAVEAT, which
    is appended to EVERY MCP response and whose own header calls the no-match sentence a money
    promise.

NOT IN THIS REPO, do not build it here:
  - The 54 GoHighLevel property-object fields. DONE by David 2026-09-17; the live reference is
    tasks/ghl-property-field-reference.md. Note flood_zone is a boolean and needs the Yes/No
    transform, and four dossier keys map to different GHL keys (zip_code->zip, apn->parcel_number_1,
    units_count->units, years_owned->years_held) which a pass-through mapper drops silently.
  - PROPERTY_FIELD_MIRROR and teaching crm_push_owners to read property_record. That is
    /Users/davidmonroe/suite-gateway. Until then PTP emits the fields and the gateway drops them.
  - PTP's own direct HighLevel push is DROPPED, not deferred.

ALSO OPEN, separate from phase 5c:
  - Three live bugs in the existing HighLevel push, all in the handoff: the manual Push to CRM
    button reports success on a failed push, a 401 is silent on all five automatic paths, and saving
    a credential validates nothing and shows a green "Connected" badge for a garbage value. None is
    tier 2 work; all three affect customers today.
  - The Supabase function-EXECUTE vuln class is open suite-wide. PTP is audited and clean; the other
    five projects are not. Recorded in suite-gateway tasks/lessons.md (commit c1b2a03). David is
    handling it when he next works the gateway.

HOW TO WORK:
  - Subagent-driven. One implementer, one reviewer. Dispatch subagents for anything that reads large
    files and keep narration to a line or two.
  - Tests FIRST on anything that touches billing, and mutation-verify every money decision: a guard
    without a test that fails when you delete the guard is not a guard. Re-run the mutations
    yourself rather than trusting the report. Three separate defects this build were invisible to
    reading and sat behind a fully green suite.
  - VERIFY YOUR MUTATIONS ACTUALLY APPLIED. A sed that never matched, a file that stops loading, and
    a genuinely surviving guard are indistinguishable from the pass/fail line alone. Assert the
    anchor matched exactly once and that the TOTAL test count did not drop. That is L-012, and it
    cost 440 lines of uncommitted work this build.
  - Before trusting a mutation that SURVIVES, check whether the two sides can differ in the test
    environment. NEXT_PUBLIC_SUITE_SIGNIN_ENABLED is false in .env.local and TRUE in production, so
    grant-aware and raw pricing are identical in every test and divergent in prod. That is L-009 and
    it has produced three worthless tests.
  - Read the saved vendor payloads in tasks/research-test/ before writing anything that parses a
    vendor response. That folder is gitignored and holds real PII: never commit from it. The
    committed sanitized fixtures are in lib/tracerfy/__tests__/fixtures/.
  - Any migration that creates a function must REVOKE from anon and authenticated BY NAME and then
    READ THE ACL BACK. See the corrected template in CLAUDE.md.
  - Verify your own work before presenting it. "7 of 9 replaced, here are the 2 I couldn't locate"
    beats a claim that it's done.

COPY RULES, these are hard:
  - No em-dashes, no en-dashes, no asterisks, no emoji, no markdown artifacts in anything
    user-facing.
  - Conversational, the way I talk. No fragment triplets, no colon-stacks.
  - Never state a price, a rate, or a capability that isn't verified in the handoff. If a number
    isn't in there, ask me rather than inferring it.

If anything goes sideways: STOP and re-plan, don't push through. Ask clarifying questions before
you begin and when stuck. Let's keep building.
