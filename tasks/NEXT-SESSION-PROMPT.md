We're working on PropTracerPRO. Phase 5c is DONE, COMMITTED AND PUSHED. `main` is at `4f694e8` and
in sync with origin. Full Property Trace (tier 2) is complete end to end, phases 1 through 5c. Four
migrations plus a security migration are applied to production and verified.

Read first, in this order:
  /Users/davidmonroe/PropTracerPRO/tasks/SESSION-HANDOFF-2026-09-16.md
    Start with the STATE OF PLAY block at the top, amended 2026-09-18 end of day. It is the ONLY
    handoff; do not create a second one, amend it. Two disagreeing documents cost a rework on 09-16.
    It carries the phase table, the pricing table, the vendor gotchas, what is open, and the three
    live HighLevel bugs.
  /Users/davidmonroe/PropTracerPRO/tasks/lessons.md
    L-013 through L-016 were earned in phase 5c. Four of them are ONE family: a green test that would
    stay green if the guard were deleted. Read L-015's closing note before you write any test.
  /Users/davidmonroe/PropTracerPRO/History.md
    The dated narrative. The 2026-09-18 entries cover all of 5c.
  /Users/davidmonroe/PropTracerPRO/tasks/todo.md
    Tasks 16, 17 and 18 are the open items. Everything else in the 5c plan is checked off.

Everything measured is already in those files with the evidence attached. Do not re-derive it.
Pricing is SETTLED: four numbers, tier 1 is $0.15 Pro/AcquisitionPRO and $0.25 pay-as-you-go, tier 2
is $0.25 and $0.40. Owner type selects the VENDOR, never the price. Do not reopen it.

BASELINES, verify against these:
  npx vitest run                  1306 passing, 67 files, 0 failing
  npx tsc --noEmit                0 errors
  npx eslint app lib components   47 problems
  npm run build                   must compile
Do NOT run bare `npm run lint`; it scans untracked worktrees and reports ~10,365. A green suite and a
clean typecheck are NOT a build.

WHAT JUST WENT LIVE, because it is a commercial change and worth watching: a bulk row with no owner
name used to be skipped and free. It now runs a Full Property Trace automatically and is billed per
record SUBMITTED, so a miss is billed. The `sweep-property-traces` cron runs every minute and returns
`processed: 0` until a bulk job with blank-owner rows is submitted. That is expected, not a wiring
fault. The first real job is the thing to eyeball.

THE NEXT PIECE OF WORK, scoped but NOT started: feed `planRoute` a parcel id.
  The dossier takes EITHER `apn + county + state` OR `address + city + state`, and the two keys FAIL
  INDEPENDENTLY. Measured: Napa hit on APN and missed on address; Salt Lake did the reverse. So every
  tier 2 row currently gets one key when it could have two, and a miss costs nothing unless it lands.
  `planRoute` ALREADY emits both steps and stops at the first hit. Nothing has ever populated
  `parcelIdLocal`.
  The ids come from the PROPERTY-REGISTRY, not from the customer. That is proven, not assumed: the
  saved test set in `tasks/research-scripts/run-research.ts` is registry-shaped, and its zip comment
  is about what Utah counties publish. So this needs NO CSV change, NO new validation and NO second
  dedup key; the row stays keyed on its address.
  The two real unknowns: PTP has no registry wiring today (`SUITE_GATEWAY_URL` is configured but no
  registry call exists in `app` or `lib`), and registry coverage varies by county. Those are the
  work, not the plumbing.

ALSO OPEN, separate from the above:
  - Three live bugs in the existing HighLevel push, all in the handoff: the manual Push to CRM button
    reports success on a failed push, a 401 is silent on all five automatic paths, and saving a
    credential validates nothing and shows a green "Connected" badge for a garbage value. None is
    tier 2 work; all three affect customers today.
  - Tasks 16, 17 and 18 in `tasks/todo.md`. None blocks anything.
  - The Supabase function-EXECUTE vuln class is still open suite-wide. PTP's TABLE grants are now
    locked; the function variant is not, in any of the six projects.

HOW TO WORK:
  - Subagent-driven. One implementer, one reviewer. Keep narration to a line or two.
  - Tests FIRST on anything touching billing, and mutation-verify every money decision. Re-run the
    mutations yourself rather than trusting the report. In phase 5c every worthless test was found by
    a mutation run and none by reading.
  - VERIFY YOUR MUTATIONS ACTUALLY APPLIED: assert the anchor matched exactly once, confirm the TOTAL
    test count did not drop, and checksum the restore. COMMIT before any mutation run.
  - Write the PREDICATE, not just a list. An enumerated list stops the reader searching, so an
    incomplete one is worse than none. That is L-016 and it cost three gaps in phase 5c.
  - Read the saved vendor payloads in `tasks/research-test/` before writing anything that parses a
    vendor response. That folder is gitignored and holds real PII: never commit from it.
  - Any migration that creates a function must REVOKE from `anon` and `authenticated` BY NAME and
    then READ THE ACL BACK. Audit table grants with `has_table_privilege()` AS ADMIN, never
    `information_schema`, which is filtered by querying role.
  - Verify your own work before presenting it. "7 of 9 replaced, here are the 2 I couldn't locate"
    beats a claim that it's done.

COPY RULES, these are hard:
  - No em-dashes, no en-dashes, no asterisks, no emoji, no markdown artifacts in anything
    user-facing. These are now enforced by tests; do not weaken those tests to make a string pass.
  - Conversational, the way I talk. No fragment triplets, no colon-stacks.
  - Never state a price, a rate or a capability that isn't verified in the handoff. If a number isn't
    in there, ask me rather than inferring it.
  - Two billing models now coexist. Tier 1 is charged per successful trace and a miss is FREE. Tier 2
    is charged per record SUBMITTED and a miss is BILLED. A sentence true of one is false of the
    other, and that single fact produced most of phase 5c's defects.

If anything goes sideways: STOP and re-plan, don't push through. Ask clarifying questions before you
begin and when stuck. Let's keep building.
