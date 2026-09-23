import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NotATier1PlanError, runSingleTier1, TIER1_CHARGE_DESCRIPTION, type SingleTier1Input } from '@/lib/trace/singleTier1'
import { requestKeyFor, type ContactResult, type RouteDeps, type StepReport } from '@/lib/routing/executeRoute'
import { planRoute, type ParcelInput } from '@/lib/routing/ownerRoute'
import { BUSY_TRY_AGAIN_REASON, OWNER_NAME_NOT_MATCHED_REASON } from '@/lib/trace/tier1Outcome'

type Op = { table: string; op: 'select' | 'update'; payload?: Record<string, unknown>; filters: unknown[][] }

const H = {
  ops: [] as Op[],
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  ledger: [] as Array<Record<string, unknown>>,
  deductData: true as unknown,
  deductError: null as { message: string } | null,
  updateError: null as { message: string } | null,
}

/** Records every select and update; answers wallet_transactions from H.ledger. */
function adminClient(): SupabaseClient {
  return {
    from(table: string) {
      const rec: Op = { table, op: 'select', filters: [] }
      const node: Record<string, unknown> = {}
      node.select = () => { rec.op = 'select'; H.ops.push(rec); return node }
      node.update = (payload: Record<string, unknown>) => { rec.op = 'update'; rec.payload = payload; H.ops.push(rec); return node }
      node.eq = (...args: unknown[]) => { rec.filters.push(['eq', ...args]); return node }
      node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(
          rec.op === 'update'
            ? { data: null, error: H.updateError }
            : { data: table === 'wallet_transactions' ? H.ledger : null, error: null }
        ).then(res, rej)
      return node
    },
    rpc(fn: string, args: Record<string, unknown>) {
      H.rpc.push({ fn, args })
      return Promise.resolve({ data: H.deductData, error: H.deductError })
    },
  } as unknown as SupabaseClient
}

const HIT: ContactResult = {
  success: true, hit: true, creditsDeducted: 5,
  contacts: { ownerName: 'Marcus Halloway', phones: [{ number: '5550000101', type: 'mobile' }], emails: [], mailingAddress: null },
}
const MISS: ContactResult = { success: true, hit: false, contacts: null, creditsDeducted: 0 }
// D29: the step log stores a COUNT, never names. peopleCount, not people.
const NOT_MATCHED: ContactResult = {
  success: true, hit: true, contacts: null, nameNotMatched: true,
  peopleCount: 1, creditsDeducted: 5,
}
const CONTACTLESS: ContactResult = {
  success: true, hit: true,
  contacts: { ownerName: 'Marcus Halloway', phones: [], emails: [], mailingAddress: null },
}
const DOWN: ContactResult = { success: false, hit: false, contacts: null, error: 'Tracerfy did not answer within 25 s' }

/** A street and a city, no parcel id: the person ladder is the Instant lookup alone. */
const PARCEL: ParcelInput = {
  state: 'OH', situsAddress: '100 Placeholder Way', situsCity: 'Placeholderville', situsState: 'OH',
  situsZip: null, parcelIdLocal: null, county: null, ownerName: 'Marcus T Halloway',
}

const deps = (over: Partial<RouteDeps> = {}): RouteDeps => ({
  lookupDossier: vi.fn(),
  traceEntity: vi.fn(async () => MISS),
  tracePerson: vi.fn(async () => MISS),
  ...over,
})

const run = (over: Partial<SingleTier1Input> = {}) =>
  runSingleTier1({
    adminClient: adminClient(),
    userId: 'user-1',
    row: { id: 'row-1', charge: 0, tier: null },
    parcel: PARCEL,
    pricePlan: 'pro',
    chargeAmount: 0.15,
    deadlineMs: Date.now() + 50_000,
    deps: deps(),
    inputOwnerName: 'Marcus T Halloway',
    ...over,
  })

const persisted = () => H.ops.find(o => o.op === 'update')?.payload
const deducts = () => H.rpc.filter(c => c.fn === 'deduct_wallet_balance')

beforeEach(() => {
  H.ops = []
  H.rpc = []
  H.ledger = []
  H.deductData = true
  H.deductError = null
  H.updateError = null
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runSingleTier1: the billing gate (spec 6.1, D8)', () => {
  it('charges once, at the rate it was given, for a name-matched result with a phone', async () => {
    const r = await run({ deps: deps({ tracePerson: vi.fn(async () => HIT) }) })
    expect(deducts()).toHaveLength(1)
    expect(deducts()[0].args).toEqual({
      p_user_id: 'user-1', p_amount: 0.15, p_trace_history_id: 'row-1', p_description: TIER1_CHARGE_DESCRIPTION,
    })
    expect(r).toMatchObject({
      outcome: 'found_by_address', foundBy: 'address', status: 'success', charge: 0.15, deduction: 'charged', skipReason: null,
    })
    expect(persisted()).toMatchObject({
      status: 'success', is_successful: true, charge: 0.15, tier: 1, outcome_code: 'found_by_address',
      found_by: 'address', contact_vendor: 'tracerfy', cost: 0.1, tracerfy_job_id: null,
      ai_research_status: null, property_trace_status: null,
    })
  })

  it('charges nothing for a matched owner with no phone and no email', async () => {
    // MUTATION: `const billable = true` (or any gate but hasContactData(result)) and this goes red.
    const r = await run({ deps: deps({ tracePerson: vi.fn(async () => CONTACTLESS) }) })
    expect(deducts()).toHaveLength(0)
    expect(r).toMatchObject({ outcome: 'no_match', status: 'no_match', charge: 0 })
  })

  it('charges nothing when the people returned are not the owner (D6), and logs what the vendor billed', async () => {
    const r = await run({ deps: deps({ tracePerson: vi.fn(async () => NOT_MATCHED) }) })
    expect(deducts()).toHaveLength(0)
    expect(r.skipReason).toBe(OWNER_NAME_NOT_MATCHED_REASON)
    expect(persisted()).toMatchObject({ outcome_code: 'owner_name_not_matched', charge: 0, cost: 0.1 })
    expect((persisted()!.trace_steps as StepReport[])[0]).toMatchObject({
      outcome: 'name_not_matched', creditsDeducted: 5, peopleCount: 1,
    })
  })

  it('never writes a returned name to trace_steps (D29)', async () => {
    // A vendor result carrying names at runtime, despite ContactResult declaring peopleCount only.
    const nameLeaking = {
      ...NOT_MATCHED,
      people: [{ first_name: 'Someoneelse', last_name: 'Different' }],
    } as unknown as ContactResult
    const r = await run({ deps: deps({ tracePerson: vi.fn(async () => nameLeaking) }) })
    expect(r.outcome).toBe('owner_name_not_matched')
    expect(JSON.stringify(persisted())).not.toMatch(/Someoneelse|Different/)
    expect((persisted()!.trace_steps as StepReport[])[0]).toMatchObject({ peopleCount: 1 })
  })

  it('a vendor failure, a timeout included, is busy_try_again: free, with its step log kept', async () => {
    const r = await run({ deps: deps({ tracePerson: vi.fn(async () => DOWN) }) })
    expect(deducts()).toHaveLength(0)
    expect(r).toMatchObject({ outcome: 'busy_try_again', status: 'error', charge: 0, skipReason: BUSY_TRY_AGAIN_REASON })
    expect(persisted()).toMatchObject({ status: 'error', is_successful: false, outcome_code: 'busy_try_again' })
    expect((persisted()!.trace_steps as StepReport[])[0]).toMatchObject({
      outcome: 'failed', error: 'Tracerfy did not answer within 25 s',
    })
  })

  it('our own refused input is never busy_try_again (spec 5.1)', async () => {
    const refused: ContactResult = {
      success: false, hit: false, contacts: null, error: 'Person trace requires address, city and state', inputError: true,
    }
    const r = await run({ deps: deps({ tracePerson: vi.fn(async () => refused) }) })
    expect(r.outcome).not.toBe('busy_try_again')
    expect(deducts()).toHaveLength(0)
  })

  it('charges the rate it was given, never a hard-coded one (Pay-As-You-Go $0.25)', async () => {
    // MUTATION: hard-code `p_amount: 0.15` in the deductWallet call and this goes red.
    const r = await run({
      pricePlan: 'wallet', chargeAmount: 0.25,
      deps: deps({ tracePerson: vi.fn(async () => HIT) }),
    })
    expect(deducts()[0].args).toMatchObject({ p_amount: 0.25 })
    expect(r.charge).toBe(0.25)
  })
})

describe('runSingleTier1: the ledger probe (spec 6.1)', () => {
  it('records, and does not take again, a debit an earlier attempt booked but never wrote to the row', async () => {
    // The crash window: deduct, then die before the persist. The resend must not charge twice.
    // MUTATION: delete the probe (always deduct) and this goes red with a second debit.
    H.ledger = [{ amount: 0.15, type: 'debit', created_at: new Date(Date.now() - 60 * 1000).toISOString() }]
    const r = await run({ deps: deps({ tracePerson: vi.fn(async () => HIT) }) })
    expect(deducts()).toHaveLength(0)
    expect(r).toMatchObject({ charge: 0.15, deduction: 'already_collected' })
    expect(persisted()).toMatchObject({ charge: 0.15, tier: 1 })
  })

  it('still charges a new purchase on a reused row whose earlier debits are already on the row', async () => {
    // MUTATION: probe for ANY debit (`total !== null && total > 0 ? total : 0`) instead of an unrecorded one and this goes red.
    H.ledger = [{ amount: 0.25, type: 'debit', created_at: '2026-08-01T00:00:00.000Z' }]
    const r = await run({ row: { id: 'row-1', charge: 0.25, tier: 2 }, deps: deps({ tracePerson: vi.fn(async () => HIT) }) })
    expect(deducts()).toHaveLength(1)
    expect(r.charge).toBe(0.15)
    // Folded onto the receipt; a tier 2 receipt never downgrades.
    // MUTATION: write `{ charge: collectedNow, tier: 1 }` instead of the fold and this goes red.
    expect(persisted()).toMatchObject({ charge: 0.4, tier: 2 })
  })

  it("does not treat an OLD debit the row never recorded as this request's money", async () => {
    // A row whose receipt was zeroed by the 2026-09-17 settle bug, or an old single-debit raw write,
    // carries a ledger surplus that is not this record's charge. The decision is bounded to the
    // 24 hour resend window, as the Tier 2 cron bounds its own (spec 6.1).
    // MUTATION: decide on `total - recorded` with no window and this goes red: no deduct, and the
    // old 0.40 reported as this request's charge.
    H.ledger = [{ amount: 0.4, type: 'debit', created_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString() }]
    const r = await run({ deps: deps({ tracePerson: vi.fn(async () => HIT) }) })
    expect(deducts()).toHaveLength(1)
    expect(r).toMatchObject({ charge: 0.15, deduction: 'charged' })
    expect(persisted()).toMatchObject({ charge: 0.15, tier: 1 })
  })

  it('still charges when the row already RECORDED a debit inside the 24 hours', async () => {
    // A Full Property Trace then a supplied-owner trace on the same address the same day, or two
    // owners on one address in a day: the earlier debit is inside the window but already on the row,
    // so it is not this request's money.
    // MUTATION: replace `Math.min(inWindow, (total ?? 0) - recorded)` with bare `inWindow` and this
    // goes red: no deduct, and the earlier 0.40 reported as this request's charge.
    H.ledger = [{ amount: 0.4, type: 'debit', created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }]
    const r = await run({ row: { id: 'row-1', charge: 0.4, tier: 2 }, deps: deps({ tracePerson: vi.fn(async () => HIT) }) })
    expect(deducts()).toHaveLength(1)
    expect(r).toMatchObject({ charge: 0.15, deduction: 'charged' })
    // Folded onto the receipt the row already carried; the tier 2 receipt never downgrades.
    expect(persisted()).toMatchObject({ charge: 0.55, tier: 2 })
  })

  it('asks the ledger nothing when nothing is billable', async () => {
    await run()
    expect(H.ops.some(o => o.table === 'wallet_transactions')).toBe(false)
  })
})

describe('runSingleTier1: a short or failed deduct never loses what the vendor already found', () => {
  it('a short wallet still delivers the contacts it already found, charging nothing new', async () => {
    // MUTATION: `collectedNow = input.chargeAmount` on this branch: red (r.charge becomes 0.15).
    // MUTATION: `deduction = 'charged'` on this branch: red (deduction is no longer 'insufficient_balance').
    H.deductData = false
    const r = await run({
      row: { id: 'row-1', charge: 0.10, tier: 1 },
      deps: deps({ tracePerson: vi.fn(async () => HIT) }),
    })
    expect(r.deduction).toBe('insufficient_balance')
    expect(r.charge).toBe(0)
    // The receipt folds in nothing new; the row's prior charge is untouched.
    expect(persisted()).toMatchObject({ charge: 0.10, status: 'success', is_successful: true })
    expect(persisted()?.trace_result).toMatchObject({ phones: [{ number: '5550000101', type: 'mobile' }] })
  })

  it('a deduct error still delivers the contacts it already found, and is logged rather than thrown', async () => {
    // MUTATION: `collectedNow = input.chargeAmount` on this branch: red, same as the short-wallet case.
    // MUTATION: `deduction = 'charged'` on this branch: red, same as the short-wallet case.
    // MUTATION: delete the `if (d.outcome === 'error') console.error(...)` line: red on the spy assertion.
    // console.error is spied fresh in beforeEach and restored in afterEach (L-013): no extra clearing needed here.
    H.deductError = { message: 'wallet RPC timed out' }
    const r = await run({
      row: { id: 'row-1', charge: 0.10, tier: 1 },
      deps: deps({ tracePerson: vi.fn(async () => HIT) }),
    })
    expect(r.deduction).toBe('error')
    expect(r.charge).toBe(0)
    expect(persisted()).toMatchObject({ charge: 0.10, status: 'success', is_successful: true })
    expect(persisted()?.trace_result).toMatchObject({ phones: [{ number: '5550000101', type: 'mobile' }] })
    expect(console.error).toHaveBeenCalled()
  })
})

describe('runSingleTier1: the busy_try_again resend (spec 5.2)', () => {
  const TRUST: ParcelInput = { ...PARCEL, ownerName: 'Marcus Halloway Revocable Trust' }
  const loggedInstantMiss = (): StepReport[] => [{
    kind: 'TRACERFY_INSTANT_NAMED', outcome: 'miss', cost: 0,
    at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    requestKey: requestKeyFor(planRoute(TRUST, 'pro').steps[0]),
  }]

  it('resumes a busy row: the answered Instant step is not bought again', async () => {
    const d = deps()
    await run({
      parcel: TRUST, deps: d,
      row: { id: 'row-1', charge: 0, tier: 1, outcome_code: 'busy_try_again', trace_steps: loggedInstantMiss() },
    })
    expect(d.tracePerson).not.toHaveBeenCalled()
    expect(d.traceEntity).toHaveBeenCalledTimes(1)
    expect((persisted()!.trace_steps as StepReport[])[0]).toMatchObject({ outcome: 'miss', reused: true })
  })

  it('resumes a preserved row that went busy while holding paid contacts (D39 part 2)', async () => {
    // TWO RUNS, CHAINED THROUGH THE COLUMNS THE FIRST ONE WROTE, because that chain IS the fix:
    // without outcome_code on the preserved branch the row keeps its old found_by_* code, the
    // resend does not recognise it as busy, and the Instant step it already answered is bought
    // again. The second run is handed exactly what the first run persisted.
    // MUTATION: never write outcome_code on the preserved branch and this goes red.
    const paidBusyRow = {
      id: 'row-1', charge: 0.25, tier: 2,
      trace_result: { owner_name: 'Earlier Owner', phones: [{ number: '5550000999', type: 'mobile' }], emails: [] },
    }

    // Run 1: the Instant step answers a miss, then the entity vendor is down. Busy, free, and the
    // row's paid contacts are preserved.
    const first = deps({ traceEntity: vi.fn(async () => DOWN) })
    const r1 = await run({ parcel: TRUST, deps: first, row: paidBusyRow })
    expect(r1.outcome).toBe('busy_try_again')
    const written = persisted()!
    expect(written).not.toHaveProperty('trace_result')

    // Run 2: the row as the database now holds it.
    H.ops = []
    const second = deps()
    await run({
      parcel: TRUST, deps: second,
      row: {
        ...paidBusyRow,
        outcome_code: written.outcome_code as string | null,
        trace_steps: written.trace_steps,
      },
    })
    expect(second.tracePerson).not.toHaveBeenCalled()
    expect(second.traceEntity).toHaveBeenCalledTimes(1)
    expect((persisted()!.trace_steps as StepReport[])[0]).toMatchObject({ outcome: 'miss', reused: true })
    // Still preserved: the contacts and the receipt are untouched by the resend too.
    expect(persisted()).not.toHaveProperty('trace_result')
    expect(persisted()).not.toHaveProperty('charge')
  })

  it('runs a row that is NOT busy fresh, whatever its log says', async () => {
    // MUTATION: pass the log through whatever the outcome_code and this goes red.
    const d = deps()
    await run({
      parcel: TRUST, deps: d,
      row: { id: 'row-1', charge: 0, tier: 1, outcome_code: 'no_match', trace_steps: loggedInstantMiss() },
    })
    expect(d.tracePerson).toHaveBeenCalledTimes(1)
  })
})

describe('runSingleTier1: a trace that finds nothing never erases a stored result (D39)', () => {
  /** The row as a reused, already-paid address stands: an EARLIER owner's contacts on it. */
  const PAID_ROW = {
    id: 'row-1',
    charge: 0.25,
    tier: 2,
    trace_result: { owner_name: 'Earlier Owner', phones: [{ number: '5550000999', type: 'mobile' }], emails: [] },
  }

  it('keeps the stored result, the old owner name, the counts, the charge and the outcome', async () => {
    // MUTATION: delete the keepStoredContacts branch (always write the full payload) and this
    // goes red: trace_result, input_owner_name, charge and the rest come back in the update.
    const r = await run({ row: PAID_ROW, inputOwnerName: 'A Different Owner' })
    const p = persisted()!
    for (const column of [
      'trace_result', 'input_owner_name', 'phone_count', 'email_count',
      'is_successful', 'charge', 'cost', 'found_by', 'outcome_code', 'tier',
    ]) {
      expect(p, column).not.toHaveProperty(column)
    }
    // Only the internal columns, the queue columns this settle always nulls, and the status the
    // stored result has always had (part 2 below).
    expect(Object.keys(p).sort()).toEqual(
      ['ai_research_status', 'contact_vendor', 'property_trace_status', 'status', 'trace_steps', 'tracerfy_job_id'].sort()
    )
    // The customer still hears THIS trace's own outcome, free.
    expect(r).toMatchObject({ outcome: 'no_match', status: 'no_match', charge: 0 })
    expect(deducts()).toHaveLength(0)
  })

  it('leaves the row reading success, so no sweep later writes error over the paid contacts', async () => {
    // Both single routes set status 'processing' on the row BEFORE this settle runs. Leaving it
    // there contradicts is_successful = true, shows the customer "Processing" in History, and
    // hands the row to app/api/cron/sweep-stale-traces, whose query is
    // status = 'processing' AND trace_job_id IS NULL and whose write is status = 'error'.
    // MUTATION: drop `status: 'success'` from the preserved branch and this goes red.
    const r = await run({ row: PAID_ROW, inputOwnerName: 'A Different Owner' })
    const p = persisted()!
    expect(p.status).toBe('success')
    // The stale sweep's own predicate now matches nothing, so it has nothing to change.
    expect(p.status).not.toBe('processing')
    // is_successful is NOT rewritten: it is already true, and the two must not disagree.
    expect(p).not.toHaveProperty('is_successful')
    expect(r.status).toBe('no_match')
  })

  it('records busy_try_again on a preserved row, so a resend can still resume its step log', async () => {
    // MUTATION: never write outcome_code on the preserved branch and the resume test below goes
    // red (the resend reads outcome_code to decide whether to reuse the log).
    const r = await run({ row: PAID_ROW, deps: deps({ tracePerson: vi.fn(async () => DOWN) }) })
    const p = persisted()!
    expect(p.outcome_code).toBe('busy_try_again')
    // Everything the customer can see is still the stored result's.
    expect(p).not.toHaveProperty('trace_result')
    expect(p).not.toHaveProperty('found_by')
    expect(p).not.toHaveProperty('is_successful')
    expect(p).not.toHaveProperty('charge')
    // status stays 'success': is_successful is true and tier1OutcomeReason returns null on a
    // successful row, so the busy code can never surface as a sentence here.
    expect(p.status).toBe('success')
    expect(r).toMatchObject({ outcome: 'busy_try_again', status: 'error', charge: 0 })
  })

  it('writes NO outcome_code on a preserved row whose outcome is an ordinary free one', async () => {
    // A no_match must not overwrite the found_by_* code the stored result was filed under.
    // MUTATION: write outcome_code unconditionally on the preserved branch and this goes red.
    const r = await run({ row: PAID_ROW })
    expect(persisted()).not.toHaveProperty('outcome_code')
    expect(r.outcome).toBe('no_match')
  })

  it('keeps a stored result whose only contact is an email', async () => {
    const r = await run({
      row: { id: 'row-1', charge: 0.15, tier: 1, trace_result: { owner_name: 'Earlier Owner', phones: [], emails: ['a@b.example'] } },
    })
    expect(persisted()).not.toHaveProperty('trace_result')
    expect(r.status).toBe('no_match')
  })

  it('overwrites a reused row that holds NO contacts, exactly as before', async () => {
    // MUTATION: drop the hasContactData(storedResult) half of the condition and this goes red.
    const r = await run({
      row: { id: 'row-1', charge: 0.4, tier: 2, trace_result: { owner_name: 'Earlier Owner', phones: [], emails: [] } },
    })
    expect(persisted()).toMatchObject({
      status: 'no_match', is_successful: false, trace_result: null, outcome_code: 'no_match', charge: 0.4, tier: 2,
    })
    expect(r.status).toBe('no_match')
  })

  it('overwrites when THIS trace delivers contacts, and charges for them', async () => {
    // MUTATION: drop the `!billable` half of the condition and this goes red: the new contacts
    // would never be written.
    const r = await run({ row: PAID_ROW, deps: deps({ tracePerson: vi.fn(async () => HIT) }) })
    expect(deducts()).toHaveLength(1)
    expect(persisted()).toMatchObject({
      status: 'success', is_successful: true, outcome_code: 'found_by_address', charge: 0.4, tier: 2,
    })
    expect(persisted()?.trace_result).toMatchObject({ phones: [{ number: '5550000101', type: 'mobile' }] })
    expect(r.charge).toBe(0.15)
  })
})

describe('runSingleTier1: what it writes', () => {
  it('refuses a record with no owner name rather than buying a dossier at the Tier 1 rate', async () => {
    // MUTATION: delete the plan.tier guard and this goes red: planRoute returns a TIER 2 plan
    // for an ownerless record, so the dossier would be bought here and billed as Tier 1.
    const d = deps()
    await expect(run({ parcel: { ...PARCEL, ownerName: '' }, deps: d })).rejects.toThrow(NotATier1PlanError)
    expect(d.lookupDossier).not.toHaveBeenCalled()
    expect(deducts()).toHaveLength(0)
    expect(H.ops.filter(o => o.op === 'update')).toHaveLength(0)
  })

  it('never writes property_record, so a reused billed tier 2 row keeps the record it paid for', async () => {
    await run({ deps: deps({ tracePerson: vi.fn(async () => HIT) }) })
    expect(persisted()).not.toHaveProperty('property_record')
  })

  it('names every key that answered in the no_match sentence', async () => {
    const r = await run({ parcel: { ...PARCEL, ownerName: 'Marcus Halloway Revocable Trust' } })
    expect(r.skipReason).toBe('We looked this owner up by address and company name and found no match. You were not charged.')
  })

  it('reports a persist failure rather than a false success', async () => {
    // MUTATION: `persistError: null` hard-coded and this goes red.
    H.updateError = { message: 'connection reset' }
    const r = await run({ deps: deps({ tracePerson: vi.fn(async () => HIT) }) })
    expect(r.persistError).toBe('connection reset')
  })

  it('writes the supplied owner name into the SAME update as trace_result (fix round 1, D25 money)', async () => {
    // MUTATION: drop input_owner_name from the persist and this goes red.
    const r = await run({
      inputOwnerName: 'Acme Holdings LLC',
      deps: deps({ tracePerson: vi.fn(async () => HIT) }),
    })
    expect(persisted()).toMatchObject({ input_owner_name: 'Acme Holdings LLC', trace_result: r.result })
  })

  it('asks the ledger and settles the row by the row id, never the user id', async () => {
    // MUTATION: probe collectedChargesFor with input.userId instead of input.row.id: red (the
    // wallet_transactions filter names 'user-1').
    // MUTATION: update `.eq('id', ...)` with a key other than input.row.id: red (the trace_history
    // filter names something other than 'row-1').
    await run({ deps: deps({ tracePerson: vi.fn(async () => HIT) }) })
    const probe = H.ops.find(o => o.table === 'wallet_transactions')
    expect(probe?.filters).toEqual([['eq', 'trace_history_id', 'row-1']])
    const update = H.ops.find(o => o.table === 'trace_history' && o.op === 'update')
    expect(update?.filters).toEqual([['eq', 'id', 'row-1']])
  })
})
