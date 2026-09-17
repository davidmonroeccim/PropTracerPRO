import { readFileSync } from 'node:fs';
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

  it('labels the tile with the fact that nothing was charged for those rows', () => {
    // The count alone reads as a failure. The user has to be told the rows were
    // free, and the tile is where the number is.
    expect(SOURCE).toContain('Skipped, not charged');
  });

  it('never writes its own copy of the reason', () => {
    // The wording lives in lib/trace/blankOwnerSkip.ts and reaches this page
    // through the route. A second copy pasted into the JSX is how the API, the
    // CSV and the screen end up saying three different things about the same
    // row, and only one of them gets updated next time.
    expect(SOURCE).not.toContain(BLANK_OWNER_SKIP_REASON);
  });
});

describe('the pre-submit count', () => {
  it('counts only the records that will actually be traced', () => {
    // "100 valid records ready to submit" sat directly above a banner saying 40
    // of them would be skipped. Two numbers, same upload, disagreeing.
    // MUTATION: put allRecords.length back as the only count and this goes red.
    expect(SOURCE).toContain('records will be traced');
    expect(SOURCE).toContain('traceableCount');
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
