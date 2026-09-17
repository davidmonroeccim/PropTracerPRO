We're building PropTracerPRO's "Full Property Trace" (tier 2). Phases 1 through 4b are DONE,
COMMITTED AND PUSHED. main is at d6c776e and in sync with origin. Both migrations are applied to
production and verified. Phase 5 is next.

Read first, in this order:
  /Users/davidmonroe/PropTracerPRO/tasks/SESSION-HANDOFF-2026-09-16.md
    Start with the STATE OF PLAY block at the very top. It is the only handoff; do not create a
    second one. Two disagreeing documents cost a rework on 09-16. It now carries the phase table,
    what 4b turned out to be, and the three live HighLevel bugs.
  /Users/davidmonroe/PropTracerPRO/tasks/todo.md
    The last section is the phase 4b review. Above it, "PLAN: Tier 2 build (2026-09-17)" is the
    spec, including the phase 5 list and the DATA FIDELITY REQUIREMENT for the export.
  /Users/davidmonroe/PropTracerPRO/tasks/lessons.md
    L-009 and L-010 especially. L-009 was earned TWICE in one phase and L-010 is why 4b got
    rewritten before a line was built.
  /Users/davidmonroe/PropTracerPRO/History.md for the dated narrative.

Everything measured is already in those files with the evidence attached. Do not re-derive it.
Pricing is SETTLED: four numbers, tier 1 is $0.15 Pro/AcquisitionPRO and $0.25 pay-as-you-go,
tier 2 is $0.25 and $0.40. Owner type selects the VENDOR, never the price. Do not reopen it.

BASELINES, verify against these:
  npx vitest run                  864 passing, 56 files, 0 failing
  npx tsc --noEmit                0 errors
  npx eslint app lib components   47 problems
  npm run build                   must compile
Do NOT run bare `npm run lint`; it scans untracked worktrees and reports ~10,365.
Run the real build before any push. A green suite and a clean typecheck are NOT a build: that gap
hid a broken deploy for two days.

PHASE 5, THE WORK:
  - Bulk tier 2. This is where a truncated run does real damage, which is why it was sequenced
    last. It needs the pre-flight balance check: parcels x the caller's tier 2 rate against the PTP
    wallet AND the Tracerfy credit balance, before the first vendor call.
  - Budget against the SHARED 500/min Tracerfy pool. Full Property Trace spends TWO calls per
    parcel, so 150 parcels is ~300 of the pool, not 150.
  - The export. `app/api/trace/bulk/download/route.ts` emits contact columns only. Every dossier
    field a customer paid for must reach the CSV: APPEND new columns, never reorder or rename
    existing ones, emit a STABLE column set every run, and blank means blank. Single-record export
    too, or the feature is bulk-only in practice.
  - Blank-owner bulk rows currently skip with a reason and are charged nothing. Bulk tier 2 is what
    gives them a route. That is the capability gap closing.

FOUR THINGS PHASE 5 MUST NOT FORGET:
  - `lib/trace/__tests__/chargeReceipt.test.ts` names FOUR files as PHASE 5 LIABILITY. They write
    `charge` raw and are safe only because bulk is tier 1 today. Bulk tier 2 is what puts a real
    receipt on those rows, and a flat `charge: 0` then starts erasing money that moved. Work that
    list; do not rediscover it.
  - The export column count is 65, not 64. todo.md says 64 in an older section; 86 returned minus 6
    blocked minus 15 propensity is 65. The blocked fields stay blocked from the export.
  - `list_traces` can return 200 rows, each potentially carrying a 65-key record, in one MCP text
    block. Harmless today because live rows are tier 1 with a null record. Revisit the default
    limit when bulk tier 2 lands.
  - The partial index from migration 20260411 is `WHERE ai_research_status = 'queued'` and no
    longer covers the five-rung claim query in sweep-entity-traces. ~3,800 rows today so it is plan
    quality, not correctness, but bulk growth changes that.

NOT IN THIS REPO, do not build it here:
  - The 54 GoHighLevel property-object fields. The list is tasks/ghl-property-fields-to-add.txt.
    David creates them in the snapshot template and pushes to users.
  - Adding those 54 rows to PROPERTY_FIELD_MIRROR and teaching crm_push_owners to read
    property_record. That is /Users/davidmonroe/suite-gateway, after the snapshot ships. Until
    then PTP emits the fields and the gateway drops them, which is expected.
  - PTP's own direct HighLevel push is DROPPED, not deferred.

ALSO OPEN, separate from phase 5:
  - Three live bugs in the existing HighLevel push, all in the handoff: the manual Push to CRM
    button reports success on a failed push, a 401 is silent on all five automatic paths, and
    saving a credential validates nothing and shows a green "Connected" badge for a garbage value.
    None is tier 2 work; all three affect customers today.

HOW TO WORK:
  - Subagent-driven. One implementer, one reviewer. Dispatch subagents for anything that reads
    large files and keep narration to a line or two.
  - Tests FIRST on anything that touches billing, and mutation-verify every money decision: a guard
    without a test that fails when you delete the guard is not a guard. Re-run the mutations
    yourself rather than trusting the report. Two of this build's worst defects were behind a fully
    green suite and were invisible to reading.
  - Before trusting a mutation that SURVIVES, check whether the two sides can actually differ in
    the test environment. That is L-009 and it cost two separate false guards.
  - Read the saved vendor payloads in tasks/research-test/ before writing anything that parses a
    vendor response. That folder is gitignored and holds real PII: never commit from it, build
    sanitized fixtures instead. The committed ones are in lib/tracerfy/__tests__/fixtures/.
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
