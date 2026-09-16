/**
 * PropTracerPRO owner-classification research harness (throwaway).
 *
 * Calls the REAL researchProperty() from the PTP-owner-extraction-fix worktree
 * against 12 commercial parcels, captures the full AIResearchResult plus cost
 * instrumentation, and writes results to a durable directory.
 *
 * SPENDS REAL MONEY (Anthropic + Brave). Use --dry-run to prove the wiring
 * without spending anything.
 *
 * Run it with (single command):
 *
 *   cd /Users/davidmonroe/PTP-owner-extraction-fix && \
 *     /private/tmp/claude-501/-Users-davidmonroe/92beb8e4-3c21-474b-b0cb-afd35b36dbc6/scratchpad/node_modules/.bin/tsx \
 *     --tsconfig /Users/davidmonroe/PTP-owner-extraction-fix/tsconfig.json \
 *     /private/tmp/claude-501/-Users-davidmonroe/92beb8e4-3c21-474b-b0cb-afd35b36dbc6/scratchpad/run-research.ts
 *
 * Flags:
 *   --dry-run      exercise everything EXCEPT researchProperty(); zero network calls.
 *   --calibration  prepend the known-answer parcel (203 Dauphin St, Mobile AL).
 *
 * SAFETY INVARIANTS (in order, and the order matters):
 *   1. .env.local is read by ABSOLUTE path. No env VALUE is ever printed or written.
 *   2. FASTAPPEND_API_KEY / TRACERFY_API_KEY / SUPABASE_SERVICE_ROLE_KEY are deleted
 *      unconditionally BEFORE any PTP module is imported. lib/tracerfy/client.ts reads
 *      its keys at MODULE LOAD into consts, so every PTP import below is dynamic.
 *   3. globalThis.fetch is replaced with a hard allowlist: only api.search.brave.com
 *      and api.anthropic.com. Everything else throws, naming the blocked host.
 *   4. researchProperty is called with EXACTLY four arguments, so asyncRecovery is
 *      undefined and no business_trace_jobs row and no Supabase write can occur.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import dotenv from 'dotenv';

// ---------------------------------------------------------------------------
// 0. Constants
// ---------------------------------------------------------------------------

const ENV_PATH = '/Users/davidmonroe/PropTracerPRO/.env.local';
const WORKTREE = '/Users/davidmonroe/PTP-owner-extraction-fix';
const OUT_DIR = '/Users/davidmonroe/PropTracerPRO/tasks/research-test';
const RAW_DIR = path.join(OUT_DIR, 'raw');

const PARCEL_TIMEOUT_MS = 90_000;

const ALLOWED_HOSTS = new Set(['api.search.brave.com', 'api.anthropic.com']);

/**
 * Rate constants. Recorded verbatim in results.json so the arithmetic is auditable.
 * Anthropic: verified 2026-09-16 against https://platform.claude.com/docs/en/about-claude/pricing
 *            ("Claude Opus 4.5" row). The prior handoff's "$5/$25 per MTok" is CORRECT.
 * Brave:     verified 2026-09-16 against https://brave.com/search/api/ (paid plan,
 *            $5 per 1,000 requests).
 */
const RATES = {
  anthropic: {
    model: 'claude-opus-4-5-20251101',
    input_usd_per_mtok: 5.0,
    output_usd_per_mtok: 25.0,
    cache_write_5m_usd_per_mtok: 6.25,
    cache_read_usd_per_mtok: 0.5,
    source:
      'https://platform.claude.com/docs/en/about-claude/pricing — "Claude Opus 4.5" row, fetched 2026-09-16',
    note:
      'lib/ai-research/client.ts sends no cache_control, so cache columns are expected to be 0. They are priced anyway so a future change stays auditable.',
  },
  brave: {
    usd_per_1000_queries: 5.0,
    usd_per_query: 0.005,
    source:
      'https://brave.com/search/api/ — paid plan, $5 per 1,000 requests, fetched 2026-09-16',
  },
} as const;

// ---------------------------------------------------------------------------
// 1. Parcels
// ---------------------------------------------------------------------------

interface Parcel {
  index: number;
  state: string;
  county: string;
  parcel_id_local: string;
  address: string;
  city: string;
  zip: string; // '' for the four Utah parcels — no UT county publishes one.
  asset_class: string;
  is_calibration?: boolean;
  ground_truth?: string;
}

const CALIBRATION_PARCEL: Omit<Parcel, 'index'> = {
  state: 'AL',
  county: 'Mobile',
  parcel_id_local: 'CALIBRATION-203-DAUPHIN',
  address: '203 Dauphin St',
  city: 'Mobile',
  zip: '36602',
  asset_class: 'retail',
  is_calibration: true,
  ground_truth:
    'Owner of record: NOBLE SOUTH INVESTMENTS LLC (Alabama entity). Known-answer check.',
};

const PARCELS: Omit<Parcel, 'index'>[] = [
  { state: 'OH', county: 'Stark',        parcel_id_local: '10000052',          address: '4898 HILLS AND DALES RD', city: 'Canton',         zip: '44708', asset_class: 'industrial' },
  { state: 'OH', county: 'Medina',       parcel_id_local: '00318B41056',       address: '1299 INDUSTRIAL PKWY N',  city: 'Brunswick',      zip: '44212', asset_class: 'medical office' },
  { state: 'OH', county: 'Richland',     parcel_id_local: '005-21-221-03-000', address: '1121 CLAYBERG RD',        city: 'Greenwich',      zip: '44837', asset_class: 'mobile home park' },
  { state: 'OH', county: 'Butler',       parcel_id_local: 'A0700006000156',    address: '5201 DIXIE HWY',          city: 'Fairfield',      zip: '45014', asset_class: 'self storage' },
  { state: 'CA', county: 'Napa',         parcel_id_local: '003330004000',      address: '1440 FIRST ST',           city: 'Napa',           zip: '94559', asset_class: 'retail' },
  { state: 'CA', county: 'Placer',       parcel_id_local: '001-011-017-000',   address: '185 PALM AV',             city: 'Auburn',         zip: '95603', asset_class: 'medical office' },
  { state: 'CA', county: 'Sacramento',   parcel_id_local: '05802620200000',    address: '2473 SUNRISE BLVD',       city: 'Rancho Cordova', zip: '95670', asset_class: 'mobile home park' },
  { state: 'CA', county: 'Contra Costa', parcel_id_local: '360010032',         address: '2770 ESTATES AVE',        city: 'Pinole',         zip: '94564', asset_class: 'multifamily' },
  { state: 'UT', county: 'Salt Lake',    parcel_id_local: '16183060290000',    address: '1815 S STATE ST',         city: 'Salt Lake City', zip: '',      asset_class: 'retail' },
  { state: 'UT', county: 'Davis',        parcel_id_local: '120220101',         address: '305 W CENTER ST',         city: 'Clearfield',     zip: '',      asset_class: 'industrial' },
  { state: 'UT', county: 'Iron',         parcel_id_local: 'B-1994-0001-0000',  address: '990 S MAIN ST',           city: 'Cedar City',     zip: '',      asset_class: 'retail' },
  { state: 'UT', county: 'Carbon',       parcel_id_local: '1A-0588-0000',      address: '213 DUCHESNE ST',         city: 'Helper',         zip: '',      asset_class: 'multifamily' },
];

// ---------------------------------------------------------------------------
// 2. Env load (absolute path) — then UNCONDITIONAL scrub, before ANY PTP import.
// ---------------------------------------------------------------------------

dotenv.config({ path: ENV_PATH, override: true, quiet: true });

// Unconditional. Deleting a key that was never set is a no-op and that is the point:
// the scrub must not depend on what .env.local happens to contain.
delete process.env.FASTAPPEND_API_KEY;
delete process.env.TRACERFY_API_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const SCRUBBED_KEYS = [
  'FASTAPPEND_API_KEY',
  'TRACERFY_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

// ---------------------------------------------------------------------------
// 3. Hard fetch allowlist + instrumentation
// ---------------------------------------------------------------------------

interface AnthropicCallRecord {
  http_status: number;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  stop_reason: string | null;
  parse_error?: string;
}

interface Recorder {
  label: string;
  brave_queries: string[];
  anthropic_calls: AnthropicCallRecord[];
  blocked_fetches: Record<string, number>;
  transport_errors: string[];
}

function makeRecorder(label: string): Recorder {
  return {
    label,
    brave_queries: [],
    anthropic_calls: [],
    blocked_fetches: {},
    transport_errors: [],
  };
}

// AsyncLocalStorage keeps attribution correct even if a parcel times out and its
// in-flight work keeps running while the next parcel starts: every continuation of
// a parcel's call chain still sees that parcel's recorder.
const als = new AsyncLocalStorage<Recorder>();
const STRAY = makeRecorder('stray (outside any parcel scope)');

function recorder(): Recorder {
  return als.getStore() ?? STRAY;
}

function hostOf(input: unknown): string {
  let raw: string;
  if (typeof input === 'string') raw = input;
  else if (input instanceof URL) raw = input.toString();
  else if (input && typeof (input as { url?: unknown }).url === 'string')
    raw = (input as { url: string }).url;
  else raw = String(input);

  try {
    return new URL(raw).hostname;
  } catch {
    return '(unparseable-url)';
  }
}

function isAllowed(host: string): boolean {
  return ALLOWED_HOSTS.has(host);
}

const realFetch = globalThis.fetch.bind(globalThis);

/**
 * The allowlist. Hosts only are ever recorded or surfaced — never a full URL,
 * because a vendor-supplied URL can carry credentials in its query string and
 * this file must never emit a secret.
 *
 * This is what stands between the run and tracerfy.com, app.fastappend.com, and
 * the unvalidated `fetch(downloadUrl)` at lib/tracerfy/client.ts:215 whose host
 * comes from a vendor response body.
 */
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const host = hostOf(input);
  const rec = recorder();

  if (!isAllowed(host)) {
    rec.blocked_fetches[host] = (rec.blocked_fetches[host] ?? 0) + 1;
    throw new Error(
      `[fetch-allowlist] BLOCKED outbound request to non-allowlisted host "${host}". ` +
        `Permitted: ${[...ALLOWED_HOSTS].join(', ')}.`
    );
  }

  if (host === 'api.search.brave.com') {
    let q = '(no q param)';
    try {
      const u = new URL(typeof input === 'string' ? input : String((input as Request).url ?? input));
      q = u.searchParams.get('q') ?? '(no q param)';
    } catch {
      /* host already parsed above; a query we cannot read is still one billable request */
    }
    rec.brave_queries.push(q);
    return realFetch(input as RequestInfo, init);
  }

  // api.anthropic.com — read the body ourselves so we can parse `usage`, then hand
  // the caller an equivalent Response. (Reading our own copy rather than .clone()
  // keeps the stream semantics trivial and deterministic.)
  let res: Response;
  try {
    res = await realFetch(input as RequestInfo, init);
  } catch (err) {
    rec.transport_errors.push(
      `anthropic transport error: ${err instanceof Error ? err.message : String(err)}`
    );
    throw err;
  }

  const text = await res.text();
  const call: AnthropicCallRecord = {
    http_status: res.status,
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    stop_reason: null,
  };
  try {
    const body = JSON.parse(text) as {
      model?: string;
      stop_reason?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };
    call.model = body.model ?? null;
    call.stop_reason = body.stop_reason ?? null;
    call.input_tokens = body.usage?.input_tokens ?? 0;
    call.output_tokens = body.usage?.output_tokens ?? 0;
    call.cache_creation_input_tokens = body.usage?.cache_creation_input_tokens ?? 0;
    call.cache_read_input_tokens = body.usage?.cache_read_input_tokens ?? 0;
  } catch {
    // An error body (or a non-JSON body) is still a call that happened. Record the
    // status, never the body — it can echo request content.
    call.parse_error = 'response body was not JSON';
  }
  rec.anthropic_calls.push(call);

  const headers = new Headers(res.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  // 204/205/304 are null-body statuses; passing a body to the Response constructor
  // would throw.
  const nullBody = res.status === 204 || res.status === 205 || res.status === 304;
  return new Response(nullBody ? null : text, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}) as typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// 4. Cost model
// ---------------------------------------------------------------------------

interface CostBreakdown {
  brave_queries: number;
  brave_usd: number;
  anthropic_calls: number;
  anthropic_input_tokens: number;
  anthropic_output_tokens: number;
  anthropic_cache_write_tokens: number;
  anthropic_cache_read_tokens: number;
  anthropic_input_usd: number;
  anthropic_output_usd: number;
  anthropic_cache_write_usd: number;
  anthropic_cache_read_usd: number;
  anthropic_usd: number;
  total_usd: number;
}

function computeCost(rec: Recorder): CostBreakdown {
  const inTok = rec.anthropic_calls.reduce((s, c) => s + c.input_tokens, 0);
  const outTok = rec.anthropic_calls.reduce((s, c) => s + c.output_tokens, 0);
  const cwTok = rec.anthropic_calls.reduce((s, c) => s + c.cache_creation_input_tokens, 0);
  const crTok = rec.anthropic_calls.reduce((s, c) => s + c.cache_read_input_tokens, 0);

  const braveUsd = rec.brave_queries.length * RATES.brave.usd_per_query;
  const inUsd = (inTok / 1_000_000) * RATES.anthropic.input_usd_per_mtok;
  const outUsd = (outTok / 1_000_000) * RATES.anthropic.output_usd_per_mtok;
  const cwUsd = (cwTok / 1_000_000) * RATES.anthropic.cache_write_5m_usd_per_mtok;
  const crUsd = (crTok / 1_000_000) * RATES.anthropic.cache_read_usd_per_mtok;
  const anthropicUsd = inUsd + outUsd + cwUsd + crUsd;

  return {
    brave_queries: rec.brave_queries.length,
    brave_usd: round6(braveUsd),
    anthropic_calls: rec.anthropic_calls.length,
    anthropic_input_tokens: inTok,
    anthropic_output_tokens: outTok,
    anthropic_cache_write_tokens: cwTok,
    anthropic_cache_read_tokens: crTok,
    anthropic_input_usd: round6(inUsd),
    anthropic_output_usd: round6(outUsd),
    anthropic_cache_write_usd: round6(cwUsd),
    anthropic_cache_read_usd: round6(crUsd),
    anthropic_usd: round6(anthropicUsd),
    total_usd: round6(braveUsd + anthropicUsd),
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// 5. Result shapes written to disk
// ---------------------------------------------------------------------------

interface ParcelOutcome {
  index: number;
  parcel: Parcel;
  status: 'ok' | 'error' | 'timeout';
  wall_ms: number;
  error: string | null;
  result: unknown; // the complete, unmodified AIResearchResult
  summary: {
    owner_name: string | null;
    owner_type: string | null;
    business_name: string | null;
    individual_behind_business: string | null;
    confidence: number | null;
    owner_occupant: boolean | null;
    business_at_address: string | null;
    source_count: number | null;
  } | null;
  instrumentation: {
    brave_query_count: number;
    brave_queries: string[];
    anthropic_call_count: number;
    anthropic_calls: AnthropicCallRecord[];
    blocked_fetches: Record<string, number>;
    transport_errors: string[];
  };
  cost: CostBreakdown;
}

interface RunFile {
  generated_at: string;
  harness: string;
  code_under_test: string;
  mode: { dry_run: boolean; calibration: boolean };
  call_signature:
    | 'researchProperty(address, city, state, zip) — exactly 4 args, asyncRecovery undefined'
    | string;
  safety: {
    env_loaded_from: string;
    scrubbed_env_keys: string[];
    scrubbed_keys_absent_after_scrub: boolean;
    fetch_allowlist: string[];
    note: string;
  };
  rate_constants: typeof RATES;
  parcel_timeout_ms: number;
  parcels: ParcelOutcome[];
  totals: CostBreakdown & { parcels_attempted: number; parcels_ok: number; parcels_failed: number };
  stray_instrumentation: {
    brave_query_count: number;
    anthropic_call_count: number;
    blocked_fetches: Record<string, number>;
  };
}

function emptyCost(): CostBreakdown {
  return computeCost(makeRecorder('empty'));
}

function sumCosts(list: CostBreakdown[]): CostBreakdown {
  const acc = emptyCost();
  for (const c of list) {
    acc.brave_queries += c.brave_queries;
    acc.brave_usd += c.brave_usd;
    acc.anthropic_calls += c.anthropic_calls;
    acc.anthropic_input_tokens += c.anthropic_input_tokens;
    acc.anthropic_output_tokens += c.anthropic_output_tokens;
    acc.anthropic_cache_write_tokens += c.anthropic_cache_write_tokens;
    acc.anthropic_cache_read_tokens += c.anthropic_cache_read_tokens;
    acc.anthropic_input_usd += c.anthropic_input_usd;
    acc.anthropic_output_usd += c.anthropic_output_usd;
    acc.anthropic_cache_write_usd += c.anthropic_cache_write_usd;
    acc.anthropic_cache_read_usd += c.anthropic_cache_read_usd;
    acc.anthropic_usd += c.anthropic_usd;
    acc.total_usd += c.total_usd;
  }
  for (const k of Object.keys(acc) as (keyof CostBreakdown)[]) {
    acc[k] = round6(acc[k]);
  }
  return acc;
}

function safeFileName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * The worktree's package.json has no `"type": "module"`, so tsx may hand back a
 * CJS namespace where the named exports hang off `.default` instead of the
 * namespace root. Read through both rather than guess which one tsx picks.
 */
function pick<T = unknown>(mod: unknown, name: string): T {
  const ns = mod as Record<string, unknown> | null;
  if (ns && typeof ns[name] !== 'undefined') return ns[name] as T;
  const dflt = ns?.default as Record<string, unknown> | undefined;
  if (dflt && typeof dflt[name] !== 'undefined') return dflt[name] as T;
  throw new Error(
    `Export "${name}" not found on the imported module (checked namespace root and .default). ` +
      `Module resolution or the ESM/CJS interop needs adjusting.`
  );
}

// ---------------------------------------------------------------------------
// 6. Dry run — proves wiring, scrub and allowlist. Makes ZERO network calls.
// ---------------------------------------------------------------------------

interface Assertion {
  name: string;
  pass: boolean;
  detail: string;
}

async function dryRun(parcels: Parcel[]): Promise<number> {
  const a: Assertion[] = [];
  const check = (name: string, pass: boolean, detail: string) => a.push({ name, pass, detail });

  // --- env scrub -----------------------------------------------------------
  for (const k of SCRUBBED_KEYS) {
    check(
      `scrub: ${k} absent from process.env`,
      !(k in process.env) && process.env[k] === undefined,
      `${k} in process.env === ${k in process.env}`
    );
  }

  // Presence only. Never the value.
  for (const k of ['ANTHROPIC_API_KEY', 'BRAVE_SEARCH_API_KEY'] as const) {
    const present = typeof process.env[k] === 'string' && process.env[k]!.length > 0;
    check(`env: ${k} present (value never printed)`, present, present ? 'present' : 'MISSING');
  }

  // --- allowlist: blocked hosts must THROW, naming the host ----------------
  const blockedProbes = [
    'https://tracerfy.com/v1/api/trace/',
    'https://app.fastappend.com/v1/api/business-trace/',
    'https://app.fastappend.com/v1/api/business-trace/123/',
    // Stand-in for the unvalidated fetch(downloadUrl) at lib/tracerfy/client.ts:215,
    // whose host is whatever the vendor response body says.
    'https://evil-vendor-supplied-host.example.com/results.csv',
    'https://s3.us-east-1.amazonaws.com/fastappend-results/x.csv',
    // Supabase write path (createAdminClient) — unreachable, but prove the net is there.
    'https://zzzzzzzzzzzz.supabase.co/rest/v1/business_trace_jobs',
    'http://169.254.169.254/latest/meta-data/',
  ];
  for (const url of blockedProbes) {
    const host = hostOf(url);
    let threw = false;
    let named = false;
    try {
      await (globalThis.fetch as unknown as (u: string) => Promise<Response>)(url);
    } catch (err) {
      threw = true;
      named = err instanceof Error && err.message.includes(host);
    }
    check(`allowlist blocks ${host}`, threw && named, threw ? (named ? 'threw, host named' : 'threw but host not named') : 'DID NOT THROW');
  }

  // Allowed hosts are asserted through the classifier, NOT by issuing a request —
  // a real Brave or Anthropic call costs money and a dry run must cost nothing.
  for (const host of ['api.search.brave.com', 'api.anthropic.com']) {
    check(`allowlist permits ${host} (classifier only, no request issued)`, isAllowed(host), 'allowed');
  }
  check(
    'dry run issued zero allowed-host requests',
    STRAY.brave_queries.length === 0 && STRAY.anthropic_calls.length === 0,
    `brave=${STRAY.brave_queries.length} anthropic=${STRAY.anthropic_calls.length}`
  );
  check(
    'blocked attempts were counted',
    Object.keys(STRAY.blocked_fetches).length === new Set(blockedProbes.map(hostOf)).size,
    JSON.stringify(STRAY.blocked_fetches)
  );

  // --- PTP module wiring (dynamic imports, AFTER the scrub) ----------------
  const researchMod = await import(`${WORKTREE}/lib/ai-research/client.ts`);
  const researchProperty = pick<(...a: unknown[]) => unknown>(researchMod, 'researchProperty');
  check(
    'researchProperty is a function',
    typeof researchProperty === 'function',
    typeof researchProperty
  );
  // NB: TypeScript optional params compile to plain params, so Function.length is 7,
  // not 4. The signature is therefore asserted against the SOURCE: args 5-7 must be
  // optional for a 4-arg call to leave asyncRecovery undefined.
  const researchSrc = fs.readFileSync(`${WORKTREE}/lib/ai-research/client.ts`, 'utf8');
  const sigOk =
    /export async function researchProperty\(\s*address:\s*string,\s*city:\s*string,\s*state:\s*string,\s*zip:\s*string,\s*ownerName\?:\s*string,\s*asyncRecovery\?:\s*AsyncRecoveryContext,\s*pollBudgetMs\?:\s*number\s*\)/.test(
      researchSrc
    );
  check(
    'researchProperty signature: args 5-7 (ownerName, asyncRecovery, pollBudgetMs) are optional',
    sigOk,
    sigOk ? 'signature matches; a 4-arg call leaves asyncRecovery undefined' : 'SIGNATURE CHANGED — re-read lib/ai-research/client.ts before running'
  );
  check(
    'researchProperty accepts at least 4 positional args',
    researchProperty.length >= 4,
    `Function.length=${researchProperty.length} (TS optional params are counted)`
  );
  check(
    'createAdminClient() is only reachable behind `pendingBusinessTrace && asyncRecovery`',
    /if \(pendingBusinessTrace && asyncRecovery\) \{[\s\S]{0,120}createAdminClient\(\)/.test(researchSrc) &&
      (researchSrc.match(/createAdminClient\(\)/g) ?? []).length === 1,
    'single call site, guarded by asyncRecovery'
  );

  // The scrub is what actually disables FastAppend: lib/tracerfy/client.ts:109 reads
  // FASTAPPEND_API_KEY at MODULE LOAD into a const, so submitBusinessTrace returns at
  // line 116 before reaching its fetch. No network call is made by this assertion.
  const tracerfyMod = await import(`${WORKTREE}/lib/tracerfy/client.ts`);
  const submitBusinessTrace = pick<
    (d: { business_name: string; state: string }) => Promise<{ success: boolean; error?: string }>
  >(tracerfyMod, 'submitBusinessTrace');
  const getBusinessTraceStatus = pick<
    (id: string) => Promise<{ success: boolean; error?: string }>
  >(tracerfyMod, 'getBusinessTraceStatus');

  const submitted = await submitBusinessTrace({ business_name: 'DRY RUN LLC', state: 'AL' });
  check(
    'submitBusinessTrace short-circuits on the scrubbed key (no fetch attempted)',
    submitted.success === false && String(submitted.error).includes('not configured'),
    JSON.stringify(submitted)
  );
  const statusRes = await getBusinessTraceStatus('0');
  check(
    'getBusinessTraceStatus short-circuits on the scrubbed key (no fetch attempted)',
    statusRes.success === false && String(statusRes.error).includes('not configured'),
    JSON.stringify(statusRes)
  );

  const adminMod = await import(`${WORKTREE}/lib/supabase/admin.ts`);
  const createAdminClient = pick<() => unknown>(adminMod, 'createAdminClient');
  let adminThrew = false;
  try {
    createAdminClient();
  } catch {
    adminThrew = true;
  }
  check(
    'createAdminClient() throws with SUPABASE_SERVICE_ROLE_KEY scrubbed',
    adminThrew,
    adminThrew ? 'threw' : 'DID NOT THROW'
  );

  const constantsMod = await import(`${WORKTREE}/lib/constants.ts`);
  const AI_RESEARCH = pick<{ CLAUDE_MODEL: string }>(constantsMod, 'AI_RESEARCH');
  check(
    'model under test matches the priced model',
    AI_RESEARCH.CLAUDE_MODEL === RATES.anthropic.model,
    `${AI_RESEARCH.CLAUDE_MODEL} vs ${RATES.anthropic.model}`
  );

  // --- parcel table --------------------------------------------------------
  const utNoZip = parcels.filter((p) => p.state === 'UT');
  check(
    'every zip is a string and never the literal "undefined"',
    parcels.every((p) => typeof p.zip === 'string' && p.zip !== 'undefined'),
    'ok'
  );
  check(
    'the four UT parcels carry an empty-string zip',
    utNoZip.length === 4 && utNoZip.every((p) => p.zip === ''),
    `${utNoZip.length} UT parcels, zips=${JSON.stringify(utNoZip.map((p) => p.zip))}`
  );
  check(
    'every parcel carries county, parcel_id_local and asset_class',
    parcels.every((p) => !!p.county && !!p.parcel_id_local && !!p.asset_class),
    'ok'
  );

  // --- output dirs ---------------------------------------------------------
  fs.mkdirSync(RAW_DIR, { recursive: true });
  check('results directory is writable', fs.existsSync(RAW_DIR), RAW_DIR);

  // --- report --------------------------------------------------------------
  let failed = 0;
  console.log('\n=== DRY RUN (no researchProperty call, zero network requests) ===\n');
  for (const r of a) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  ${r.pass ? '' : `-> ${r.detail}`}`);
  }
  console.log(`\n${a.length - failed}/${a.length} assertions passed.`);
  console.log(`Parcels that WOULD run: ${parcels.length}`);
  for (const p of parcels) {
    console.log(
      `  [${String(p.index).padStart(2)}] ${p.address}, ${p.city}, ${p.state} ${p.zip || '(no zip)'} | ${p.county} | ${p.parcel_id_local} | ${p.asset_class}`
    );
  }
  console.log(
    `\nRates: Anthropic ${RATES.anthropic.model} $${RATES.anthropic.input_usd_per_mtok}/$${RATES.anthropic.output_usd_per_mtok} per MTok; Brave $${RATES.brave.usd_per_1000_queries}/1k queries.\n`
  );
  return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// 7. Live run
// ---------------------------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  return Promise.race([
    p.then((value) => ({ timedOut: false as const, value })),
    timeout,
  ]).finally(() => clearTimeout(timer!));
}

async function liveRun(parcels: Parcel[], calibration: boolean): Promise<number> {
  for (const k of ['ANTHROPIC_API_KEY', 'BRAVE_SEARCH_API_KEY'] as const) {
    if (!process.env[k]) {
      console.error(`FATAL: ${k} is not set after loading ${ENV_PATH}. (Value never printed.)`);
      return 1;
    }
  }

  fs.mkdirSync(RAW_DIR, { recursive: true });

  const researchMod = await import(`${WORKTREE}/lib/ai-research/client.ts`);
  const researchProperty = pick<
    (address: string, city: string, state: string, zip: string) => Promise<unknown>
  >(researchMod, 'researchProperty');

  const run: RunFile = {
    generated_at: new Date().toISOString(),
    harness: __filenameCompat(),
    code_under_test: `${WORKTREE}/lib/ai-research/client.ts :: researchProperty()`,
    mode: { dry_run: false, calibration },
    call_signature:
      'researchProperty(address, city, state, zip) — exactly 4 args, asyncRecovery undefined',
    safety: {
      env_loaded_from: ENV_PATH,
      scrubbed_env_keys: [...SCRUBBED_KEYS],
      scrubbed_keys_absent_after_scrub: SCRUBBED_KEYS.every((k) => process.env[k] === undefined),
      fetch_allowlist: [...ALLOWED_HOSTS],
      note:
        'No env VALUE is recorded anywhere in this file. Blocked fetches are recorded by HOST only, never full URL.',
    },
    rate_constants: RATES,
    parcel_timeout_ms: PARCEL_TIMEOUT_MS,
    parcels: [],
    totals: { ...emptyCost(), parcels_attempted: 0, parcels_ok: 0, parcels_failed: 0 },
    stray_instrumentation: { brave_query_count: 0, anthropic_call_count: 0, blocked_fetches: {} },
  };

  const writeRunFile = () => {
    run.totals = {
      ...sumCosts(run.parcels.map((p) => p.cost)),
      parcels_attempted: run.parcels.length,
      parcels_ok: run.parcels.filter((p) => p.status === 'ok').length,
      parcels_failed: run.parcels.filter((p) => p.status !== 'ok').length,
    };
    run.stray_instrumentation = {
      brave_query_count: STRAY.brave_queries.length,
      anthropic_call_count: STRAY.anthropic_calls.length,
      blocked_fetches: STRAY.blocked_fetches,
    };
    fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(run, null, 2) + '\n');
  };

  console.log(
    `\n=== LIVE RUN — ${parcels.length} parcel(s), sequential, ${PARCEL_TIMEOUT_MS / 1000}s timeout each ===`
  );
  console.log(`Results: ${OUT_DIR}\n`);

  for (const parcel of parcels) {
    const rec = makeRecorder(`parcel-${parcel.index}-${parcel.parcel_id_local}`);
    const started = Date.now();

    let status: ParcelOutcome['status'] = 'ok';
    let error: string | null = null;
    let result: unknown = null;

    try {
      const outcome = await als.run(rec, () =>
        withTimeout(
          // EXACTLY four arguments. No asyncRecovery => no business_trace_jobs row,
          // no Supabase write.
          researchProperty(parcel.address, parcel.city, parcel.state, parcel.zip),
          PARCEL_TIMEOUT_MS
        )
      );
      if (outcome.timedOut) {
        status = 'timeout';
        error = `Timed out after ${PARCEL_TIMEOUT_MS}ms. The underlying call cannot be aborted; it may still complete in the background. Its instrumentation stays attributed to this parcel via AsyncLocalStorage.`;
      } else {
        result = outcome.value;
      }
    } catch (err) {
      status = 'error';
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }

    const wall_ms = Date.now() - started;
    const cost = computeCost(rec);
    const r = result as Record<string, unknown> | null;

    const outcome: ParcelOutcome = {
      index: parcel.index,
      parcel: { ...parcel },
      status,
      wall_ms,
      error,
      result,
      summary: r
        ? {
            owner_name: (r.owner_name as string | null) ?? null,
            owner_type: (r.owner_type as string | null) ?? null,
            business_name: (r.business_name as string | null) ?? null,
            individual_behind_business: (r.individual_behind_business as string | null) ?? null,
            confidence: typeof r.confidence === 'number' ? r.confidence : null,
            owner_occupant: typeof r.owner_occupant === 'boolean' ? r.owner_occupant : null,
            business_at_address: (r.business_at_address as string | null) ?? null,
            source_count: Array.isArray(r.sources) ? r.sources.length : null,
          }
        : null,
      instrumentation: {
        brave_query_count: rec.brave_queries.length,
        brave_queries: rec.brave_queries,
        anthropic_call_count: rec.anthropic_calls.length,
        anthropic_calls: rec.anthropic_calls,
        blocked_fetches: rec.blocked_fetches,
        transport_errors: rec.transport_errors,
      },
      cost,
    };

    // Write the raw AIResearchResult IMMEDIATELY so a crash at parcel 9 cannot
    // lose parcels 1-8. `null` means "no result" (error or timeout).
    fs.writeFileSync(
      path.join(RAW_DIR, `${safeFileName(parcel.parcel_id_local)}.json`),
      JSON.stringify(result, null, 2) + '\n'
    );

    run.parcels.push(outcome);
    writeRunFile();

    const blocked = Object.entries(rec.blocked_fetches);
    console.log(
      `[${String(parcel.index).padStart(2)}/${parcels.length}] ${parcel.address}, ${parcel.city}, ${parcel.state} | ` +
        `owner=${outcome.summary?.owner_name ?? 'NULL'} | type=${outcome.summary?.owner_type ?? 'n/a'} | ` +
        `conf=${outcome.summary?.confidence ?? 'n/a'} | brave=${cost.brave_queries} claude=${cost.anthropic_calls} | ` +
        `$${cost.total_usd.toFixed(4)} | ${wall_ms}ms | ${status}` +
        (blocked.length ? ` | BLOCKED: ${blocked.map(([h, n]) => `${h}x${n}`).join(', ')}` : '') +
        (error ? ` | ${error}` : '')
    );
  }

  writeRunFile();

  console.log('\n=== TOTALS ===');
  console.log(
    `parcels ok/failed: ${run.totals.parcels_ok}/${run.totals.parcels_failed}  |  ` +
      `brave queries: ${run.totals.brave_queries} ($${run.totals.brave_usd.toFixed(4)})  |  ` +
      `claude calls: ${run.totals.anthropic_calls} (in ${run.totals.anthropic_input_tokens} / out ${run.totals.anthropic_output_tokens} tok, $${run.totals.anthropic_usd.toFixed(4)})`
  );
  console.log(`TOTAL: $${run.totals.total_usd.toFixed(4)}`);
  if (Object.keys(STRAY.blocked_fetches).length) {
    console.log(`Stray blocked fetches (outside any parcel scope): ${JSON.stringify(STRAY.blocked_fetches)}`);
  }
  console.log(`\nWrote ${path.join(OUT_DIR, 'results.json')} and ${run.parcels.length} file(s) under ${RAW_DIR}\n`);
  return 0;
}

function __filenameCompat(): string {
  try {
    return new URL(import.meta.url).pathname;
  } catch {
    return '(unknown)';
  }
}

// ---------------------------------------------------------------------------
// 8. Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const isDryRun = argv.includes('--dry-run');
  const isCalibration = argv.includes('--calibration');

  const base = isCalibration ? [CALIBRATION_PARCEL, ...PARCELS] : [...PARCELS];
  const parcels: Parcel[] = base.map((p, i) => ({ ...p, index: i + 1 }));

  if (isDryRun) return dryRun(parcels);
  return liveRun(parcels, isCalibration);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('FATAL:', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    process.exitCode = 1;
  });
