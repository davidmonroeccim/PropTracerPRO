import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BLANK_OWNER_SKIP_REASON } from '@/lib/trace/blankOwnerSkip';

/**
 * The bulk page's job summary, checked at the SOURCE.
 *
 * WHY NOT A RENDER. The other page test in this repo
 * (app/(dashboard)/trace/single/__tests__/page.test.tsx) renders its page with
 * renderToStaticMarkup, which works there because the form it asserts on is on
 * screen from the first paint. Everything asserted here lives in the
 * 'processing' and 'complete' phases of a useState machine that starts at
 * 'upload', and reaching those needs a submit, a fetch and a poll. There is no
 * jsdom and no testing-library in this project, so a static render cannot get
 * there.
 *
 * WHAT THAT MEANS FOR WHAT THESE PROVE. They are WIRING guards: they go red when
 * the page stops reading a field or stops mounting a component, which is the
 * regression that actually happened. They cannot see a CONDITION change -- a
 * mutation that leaves the JSX in place and makes it unreachable survives every
 * assertion in this file, and one did on the first mutation run. That is why the
 * block itself lives in components/trace/BulkSkipSummary.tsx, which IS rendered
 * in its own test and owns the decision about whether there is anything to show.
 * Nothing conditional about the skip summary is left in the page for these tests
 * to be blind to.
 *
 * WHAT THEY HOLD. David's rule for a blank-owner bulk row is that it is
 * accepted, skipped with a reason, charged nothing, and that the reason is
 * visible in the job summary AND the CSV. The CSV half shipped first. This page
 * had the pre-submit warning and the CSV, and nothing in between: a user who
 * uploaded 100 rows with 40 blank owners saw a finished job whose skipped rows
 * read as a bare no_match and had to download the CSV to find out why.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL('../page.tsx', import.meta.url)),
  'utf8'
);

/**
 * The same source with every run of whitespace collapsed to one space.
 *
 * A sentence in JSX is wrapped by the formatter wherever the line ran out, so
 * asserting on prose against the raw file means asserting on where Prettier
 * happened to break it. Those assertions pass today and go red on a reformat
 * that changed no copy at all, which trains the next person to loosen them.
 * Structural assertions (identifiers, props, constants) stay on SOURCE, because
 * there the exact text is the point.
 */
const PROSE = SOURCE.replace(/\s+/g, ' ');

describe('the finished job summary', () => {
  it('reads the skipped count and reason back off the status response', () => {
    // MUTATION: drop either key from the completed branch and this goes red.
    // The status route serves both (app/api/trace/bulk/status/route.ts); a page
    // that does not read them leaves the user with the CSV as the only answer.
    expect(SOURCE).toContain('statusData.records_skipped');
    expect(SOURCE).toContain('statusData.skip_reason');
  });

  it('falls back to what the submit response already said', () => {
    // The submit response carries records_skipped / skipped_reason before any
    // job exists, and it is the ONLY source for an upload that was entirely
    // blank-owner rows. Falling back to zero would erase a skip the user was
    // already told about one screen earlier.
    expect(SOURCE).toContain('data.records_skipped');
    expect(SOURCE).toContain('data.skipped_reason');
  });

  it('hands both to the component that renders them', () => {
    // Asserted as whole PROPS, not as bare field names. `records_skipped`
    // appears elsewhere in this file, so a looser assertion survived a mutation
    // that passed a literal 0 to the component and blanked the notice.
    // MUTATION: unmount BulkSkipSummary, or feed it anything but the real
    // count, and this goes red. What the component does with the values is
    // proved by its own render test.
    expect(SOURCE).toContain('<BulkSkipSummary');
    expect(SOURCE).toContain('recordsSkipped={completeStats?.records_skipped}');
    expect(SOURCE).toContain('skipReason={completeStats?.skip_reason}');
  });

  it('shows the same block while the job is still running', () => {
    // The user should not have to wait for a job to finish to learn that a
    // third of their upload was never sent anywhere.
    expect(SOURCE).toContain('recordsSkipped={jobStats?.records_skipped}');
    expect(SOURCE).toContain('skipReason={jobStats?.skipped_reason}');
  });

  it('never labels that count "not charged", because one kind of row was', () => {
    // IT USED TO, AND THE LABEL WAS RIGHT AT THE TIME: every row this count
    // could contain was free. The status route now builds it from
    // rowSkipReason(), which answers for both queues, and a
    // property_trace_no_reach row was charged per record submitted before its
    // contact lookup failed. A tile promising "not charged" over a number that
    // can include it is a false statement about the customer's own money.
    // MUTATION: put "Skipped, not charged" back on either tile and this goes red.
    expect(SOURCE).not.toContain('Skipped, not charged');
    expect(SOURCE).not.toMatch(/Skipped[^\n]*not charged/);
  });

  it('labels the tile with the subset it actually holds, not a wider category', () => {
    // TWO SEPARATE WRONGS, AND THE SECOND WAS INTRODUCED FIXING THE FIRST.
    // The original label promised the rows were free, which stopped being true.
    // Its replacement, "No contacts returned", was true of every counted row and
    // false as a category: `records_skipped` holds only rows carrying a stated
    // reason, so on a 100-record job with 40 matched, 48 genuine misses and 12
    // explained rows it announced 12 where the real no-contact figure was 60,
    // sitting directly beside "Records Matched 40".
    // MUTATION: widen the label back and this goes red. Both phases use it.
    expect(SOURCE.match(/Records We Can Explain/g) ?? []).toHaveLength(2);
    expect(SOURCE).not.toContain('No contacts returned');
  });

  it('never writes its own copy of the reason', () => {
    // The wording lives in lib/trace/blankOwnerSkip.ts and reaches this page
    // through the route. A second copy pasted into the JSX is how the API, the
    // CSV and the screen end up saying three different things about the same
    // row, and only one of them gets updated next time.
    expect(SOURCE).not.toContain(BLANK_OWNER_SKIP_REASON);
  });
});

/*
 * THE HALF-FAILED SUBMIT, WHICH THE ROUTE REPORTED HONESTLY AND THE PAGE DROPPED.
 *
 * When the Tracerfy submit for the owner-name half of a file fails, the route
 * answers 200 with records_failed, re-quotes records_submitted and estimated_cost
 * down to the survivors, and names which half died in `message`. None of that
 * reached the screen: records_failed was not in the JobStats interface and was
 * rendered nowhere, and `message` was shown only when NO row carried a skip
 * reason. So a 100-record upload whose 60 owner-name rows were never sent showed
 * Total Uploaded 100, Records Matched 12, and nothing at all about the 60.
 *
 * Because every other number is re-quoted to the survivors, no arithmetic on this
 * page can recover the fact. The tile is the only place it can appear.
 */
describe('a submit where half the file was never sent', () => {
  it('reads records_failed off the submit response at all', () => {
    // MUTATION: drop the field from JobStats and this goes red. It was absent
    // from the interface for the whole life of the defect, so the value arrived
    // and was discarded at the type boundary.
    expect(SOURCE).toContain('records_failed');
  });

  it('gives it a tile in BOTH phases, because both are read as the account', () => {
    // The processing card is where a user lands the moment they submit; the
    // complete card is what they read afterwards. A count on only one of them is
    // a fact that disappears when the job finishes.
    expect(SOURCE.match(/Records We Could Not Send/g) ?? []).toHaveLength(2);
    expect(SOURCE).toContain('{jobStats.records_failed}');
  });

  it('never claims those rows were charged or not charged on the tile', () => {
    // The money claim belongs to the route's sentence, which knows which half
    // failed and under which billing model. A tile label that guessed would be a
    // statement about the customer's money made by the wrong layer.
    expect(PROSE).not.toMatch(/Records We Could Not Send[^<]*charged/);
  });

  it('stops suppressing the route sentence whenever any row carries a reason', () => {
    // THE EXACT CONDITION THAT HID IT. `!completeStats?.records_skipped &&
    // jobStats?.message` reads as "do not say the same thing twice", and it is
    // right about the no-key message on the happy path. On a half-failed submit
    // the message is a DIFFERENT fact, and five explained rows were enough to
    // silence it.
    // MUTATION: restore the bare `!completeStats?.records_skipped` guard and
    // this goes red.
    expect(PROSE).toContain(
      "{jobStats?.message && ((jobStats.records_failed || 0) > 0 || !completeStats?.records_skipped) && ("
    );
  });

  it('says it while the job is still running, not only once it finishes', () => {
    // The processing phase rendered the message nowhere at all, and that is the
    // screen the customer is looking at when the submit comes back.
    expect(PROSE).toContain(
      "{(jobStats?.records_failed || 0) > 0 && jobStats?.message && ("
    );
  });
});

describe('the pre-submit count', () => {
  it('counts every record, because every record is now traced', () => {
    // THE OLD SHAPE AND WHY IT WENT. This read "N of M records will be traced"
    // whenever rows were being skipped, so that a total could not sit above a
    // banner saying 40 rows were dropped: two numbers, one upload, disagreeing.
    // Phase 5c-3A made blank-owner rows run a full property trace, so nothing is
    // dropped, the two numbers are equal and the conditional was dead copy.
    // MUTATION: reintroduce a second, smaller total and this goes red.
    expect(SOURCE).toContain('records ready to submit');
    expect(SOURCE).not.toContain('records will be traced');
    expect(SOURCE).not.toContain('traceableCount');
  });

  it('never says a blank-owner row is skipped or free', () => {
    // The banner used to read "We skip those and you are not charged for them.
    // Add the owner of record to those rows and upload again if you want them
    // traced." All of it is false now, and the instruction is the worst part:
    // the user no longer has to do anything.
    expect(SOURCE).not.toContain('We skip those and you are not charged');
    expect(SOURCE).not.toContain('upload again if you want them traced');
  });

  it('tells a blank-owner uploader the rows are billed whether or not we find anything', () => {
    // This is the change to what existing bulk users PAY, and the upload screen
    // is the last place they can act on it. 273 of 1,270 historical bulk rows
    // arrived with no owner name.
    expect(PROSE).toContain('charged for every record you send');
    expect(PROSE).toContain('whether or not we come back with contacts');
  });
});

describe('the cost estimate', () => {
  it('prices the two halves of the file on their own models', () => {
    // "per successful match" is the TIER 1 model and was quoted over the whole
    // upload. A blank-owner row is tier 2, charged per record submitted, so one
    // rate and one model covering both halves is wrong for somebody either way.
    // MUTATION: drop either rate from the estimate and this goes red.
    expect(SOURCE).toContain('perTraceRate');
    expect(SOURCE).toContain('perRecordRate');
    expect(SOURCE).toContain('ownedCount * perTraceRate + blankOwnerCount * perRecordRate');
  });

  it('reads the tier 2 rate off the caller profile rather than assuming one', () => {
    // Four rates exist and each caller has exactly one of them.
    expect(SOURCE).toContain('chargePerRecord');
    expect(SOURCE).toContain('setPerRecordRate(chargePerRecord(data))');
  });

  it('no longer promises the whole file is charged only on a match', () => {
    expect(SOURCE).not.toContain('per successful match');
    expect(SOURCE).not.toContain('Estimated max trace cost');
  });

  it('says only what is true of both models on the tile', () => {
    // An all-tier-2 upload's number is not an estimate and not a maximum, it is
    // the price. "Most this can cost" is a ceiling for tier 1 and exactly right
    // for tier 2.
    expect(SOURCE).toContain('Most This Can Cost');
    expect(SOURCE).not.toContain('Estimated Max Cost');
  });
});

describe('the record cap, refused at selection time', () => {
  it('refuses at the same number all three submit routes hold', () => {
    // THE CAP LIVES IN FOUR PLACES AND CANNOT BE IMPORTED INTO THE FOURTH.
    // Pulling a submit route into this page would drag its whole vendor and
    // billing graph into a client bundle, so the page keeps a local constant,
    // the same way the download route keeps its own. This is what stops the four
    // drifting: a UI that refuses at a number the routes do not hold is either
    // blocking work the product accepts, or waving through an upload the user
    // then waits on only to be refused.
    // MUTATION: change any one of the four and this goes red.
    const caps = [
      'app/(dashboard)/trace/bulk/page.tsx',
      'app/api/trace/bulk/route.ts',
      'app/api/v1/trace/bulk/route.ts',
      'lib/suite/mcp-tools.ts',
    ].map((path) => {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      const declared = source.match(/MAX_RECORDS = (\d+)/);
      expect(declared, `no MAX_RECORDS in ${path}`).not.toBeNull();
      return declared![1];
    });

    expect(new Set(caps).size, `the cap disagrees across surfaces: ${caps.join(', ')}`).toBe(1);
    expect(caps[0]).toBe('500');
  });

  it('checks the file on BOTH parsers, not just the CSV one', () => {
    // An .xlsx over the cap used to sail past a CSV-only guard and be refused by
    // the route after the user had waited on a submit.
    expect(SOURCE.match(/> MAX_RECORDS/g) ?? []).toHaveLength(2);
    expect(SOURCE).not.toContain('10,000 records per upload');
    expect(SOURCE).not.toContain('> 10000');
  });

  it('states the cap in records and says what to do about it', () => {
    expect(SOURCE).toContain('We can take up to ${MAX_RECORDS} records in one go');
    expect(PROSE).toContain('Split it into smaller files');
  });

  it('does not tell a customer their job is over the limit when it may not be', () => {
    // THE CHECK IS ON ROWS AND THE CAP IS ON RECORDS, and they are not the same
    // number: mapRows drops any row missing an address, city or state before the
    // page posts, so a 520-row export with 30 unusable rows is a legitimate
    // 490-record job this refuses. The copy must therefore say THIS FILE has
    // more rows than the cap, which is the fact actually checked, rather than
    // "you can send up to 500 records", which a refused 490-record customer
    // reads as a statement about their job.
    expect(PROSE).toContain('this file has more rows than that');
    expect(PROSE).not.toContain('This file has more rows than we can take');
  });
});

describe('the long-job handoff', () => {
  it('leaves the processing card instead of stranding the user on it', () => {
    // THE DEAD END. On poll exhaustion the page set an error and stopped the
    // spinner but never moved `phase`, so it sat on the processing card showing
    // a spinner AND a red error, with no button and no way back, while the job
    // kept running server-side.
    // MUTATION: put setError(...) back in place of the phase change and this
    // goes red.
    expect(SOURCE).toContain("setPhase('checkback')");
    expect(SOURCE).not.toContain('Processing is taking longer than expected');
  });

  it('routes them to history, which already has the CSV and the CRM push', () => {
    expect(SOURCE).toContain("window.location.href = '/history'");
    expect(SOURCE).toContain('Go to History');
  });

  it('hands over the job id so two uploads of one file are tellable apart', () => {
    expect(SOURCE).toContain('Job reference');
  });

  it('says plainly that the work continues without the page open', () => {
    // It is true (a cron settles it) and it is what makes the handoff honest
    // rather than a shrug. The processing card used to say the opposite.
    expect(PROSE).toContain('carries on in the background');
    expect(PROSE).not.toContain('Please keep this page open');
  });

  it('does not call it an error, because nothing failed', () => {
    expect(PROSE).toContain('Nothing has gone wrong and nothing has stopped');
  });
});

describe('copy that must never appear on this page', () => {
  it('never claims anyone was notified, because PTP has no alerting channel', () => {
    expect(SOURCE).not.toMatch(/notified|alerted|our team (is|has)|looking into it/i);
  });

  it('never tells the customer to add funds when the shortfall is ours', () => {
    // The vendor-capacity refusal is PTP's problem, not their wallet's. This
    // page renders the route's error text verbatim, so it must not add its own.
    expect(SOURCE).not.toMatch(/add funds/i);
  });
});

describe('copy rules', () => {
  it('carries no em-dashes, en-dashes or emoji', () => {
    expect(SOURCE).not.toMatch(/[—–]/);
    expect(SOURCE).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it('hardcodes no price', () => {
    // Every figure on this page is derived from the caller's own profile rate.
    // A literal dollar amount in the source is a rate quoted to everybody.
    expect(SOURCE).not.toMatch(/\$\d/);
  });
});
