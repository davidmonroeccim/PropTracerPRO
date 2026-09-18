import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BulkSkipSummary } from '@/components/trace/BulkSkipSummary';
import { BLANK_OWNER_SKIP_REASON } from '@/lib/trace/blankOwnerSkip';
import { ENTITY_TRACE_FAILED_REASON } from '@/lib/trace/entityTraceAttempts';
import { PROPERTY_TRACE_NO_REACH_REASON } from '@/lib/trace/propertyTraceAttempts';

/**
 * The on-screen half of the rule that a row which came back empty is never left
 * to speak as a bare no_match.
 *
 * WHAT THESE TESTS HAD TO CHANGE IN 5c-3B. They were written when every reason
 * this component could carry belonged to a free row, so they asserted the
 * heading said "We skipped N of your records" and that the block told the user
 * they were not charged. Tier 2 broke both: a property_trace_no_reach row was
 * not skipped, it was run and billed, and only the contact vendor failed. The
 * heading now makes NO money claim and each reason sentence carries its own,
 * which is what the two tests at the bottom of the second block pin.
 *
 * A static render is the whole harness, as it is for FullTraceDisclosure: this
 * component holds no state and runs no effects.
 */

/**
 * The words a customer actually reads, with the markup taken out.
 *
 * The "must not say" assertions below need this rather than the raw markup. The
 * wrapper still carries data-testid="skipped-summary", which is an identifier
 * other tests hold on to and which no customer ever sees, so a scan of the raw
 * string finds the word "skipped" in every render and the assertion is either
 * vacuously red or quietly weakened to let it through. Reading the visible text
 * asks the question that matters: what does this tell the person looking at it.
 */
function visibleText(markup: string): string {
  return markup.replace(/<[^>]*>/g, ' ');
}

describe('when nothing was skipped', () => {
  it('renders nothing at all', () => {
    // A skip notice on a job where every row was traced is a false statement in
    // the other direction.
    // MUTATION: drop the count guard and this goes red.
    expect(renderToStaticMarkup(<BulkSkipSummary recordsSkipped={0} skipReason={null} />)).toBe('');
  });

  it('renders nothing when the route said nothing about skips', () => {
    // An older job, or a status response that predates the field. Absent is not
    // zero-with-a-notice.
    expect(
      renderToStaticMarkup(<BulkSkipSummary recordsSkipped={undefined} skipReason={undefined} />)
    ).toBe('');
    expect(renderToStaticMarkup(<BulkSkipSummary recordsSkipped={null} skipReason={null} />)).toBe(
      ''
    );
  });
});

describe('when rows were skipped', () => {
  const markup = renderToStaticMarkup(
    <BulkSkipSummary recordsSkipped={40} skipReason={BLANK_OWNER_SKIP_REASON} />
  );

  it('says how many', () => {
    expect(markup).toContain('We can explain why 40 of your records came back without contacts');
  });

  it('does not call them skipped, because one of the five kinds was not', () => {
    // A property_trace_no_reach row was traced and billed. The heading is shared
    // by all five reasons, so it cannot use a word that is false for one of them.
    // MUTATION: put "We skipped N of your records" back and this goes red.
    expect(visibleText(markup)).not.toMatch(/\bskipped\b/i);
  });

  it('says why, in the words the API and the CSV use', () => {
    // MUTATION: drop the reason paragraph and this goes red -- the user is back
    // to downloading the CSV to find out why 40 rows came back empty.
    expect(markup).toContain('No owner name came in for this address');
  });

  it('tells them they were not charged for those rows', () => {
    // The whole point. A count on its own reads as a failure they paid for.
    expect(markup).toContain('not charged');
  });

  it('reads sensibly for a single row', () => {
    const one = renderToStaticMarkup(
      <BulkSkipSummary recordsSkipped={1} skipReason={BLANK_OWNER_SKIP_REASON} />
    );
    expect(one).toContain('We can explain why 1 of your records came back without contacts');
  });

  it('carries a vendor-exhausted reason just as faithfully', () => {
    // Two different ways a row goes untraced, and they are not the same thing to
    // a customer. This component must not assume the blank-owner one.
    const exhausted = renderToStaticMarkup(
      <BulkSkipSummary recordsSkipped={2} skipReason={ENTITY_TRACE_FAILED_REASON} />
    );
    expect(exhausted).toContain('business records service');
    expect(exhausted).not.toContain('No owner name came in');
  });

  it('shows the count even when no reason came back, and invents none', () => {
    // CLAUDE.md rule 7. A missing reason is a fact about the response, not a
    // licence to write a plausible sentence.
    const noReason = renderToStaticMarkup(<BulkSkipSummary recordsSkipped={3} skipReason={null} />);
    expect(noReason).toContain('We can explain why 3 of your records came back without contacts');
    expect(noReason).not.toContain('not charged');
    expect(noReason).not.toContain('owner');
  });

  it('never tells a BILLED row it was free, or that we skipped it', () => {
    // THE ROW 5c-2 CREATED ITS STATUS FOR. The property record was bought and
    // charged per record submitted, and only the contact lookup failed. Every
    // other reason this component carries ends in "not charged", so the danger
    // is the heading or a neighbouring line supplying that claim for this one.
    // MUTATION: put a "not charged" or "we skipped" line back into the component
    // and this goes red.
    const billed = renderToStaticMarkup(
      <BulkSkipSummary recordsSkipped={5} skipReason={PROPERTY_TRACE_NO_REACH_REASON} />
    );
    expect(visibleText(billed)).not.toContain('not charged');
    expect(visibleText(billed)).not.toMatch(/\bfree\b/i);
    expect(visibleText(billed)).not.toMatch(/\bskipped\b/i);
  });

  it('claims only the rows it counted, not every record that came back empty', () => {
    // THE OVER-CLAIM THAT REPLACED THE OLD FALSE MONEY CLAIM. `records_skipped`
    // counts only rows carrying a stated reason; a row a vendor was genuinely
    // asked about returns null from rowSkipReason and is excluded however empty
    // it came back. "We could not get contacts for 40 of your records" was
    // therefore true of each counted row and false about the job: on a
    // 100-record job with 40 matched and 48 genuine misses it announced 40 where
    // the real figure was 60, and a customer reading it beside Records Matched
    // concludes the rest got contacts.
    // MUTATION: restore a heading that states the category without scoping it to
    // what we can explain, and this goes red.
    expect(markup).toContain('We can explain why');
    expect(markup).not.toContain('We could not get contacts for');
  });

  it('carries the billed row its own charge statement, not an absence', () => {
    // The heading makes no money claim by design, so the sentence is the ONLY
    // place this customer learns they paid for the row. A reason string that
    // said nothing about money would leave them to infer it from silence.
    const billed = renderToStaticMarkup(
      <BulkSkipSummary recordsSkipped={5} skipReason={PROPERTY_TRACE_NO_REACH_REASON} />
    );
    expect(billed).toContain('You were charged for it');
  });
});

describe('copy rules', () => {
  const markup = renderToStaticMarkup(
    <BulkSkipSummary recordsSkipped={40} skipReason={BLANK_OWNER_SKIP_REASON} />
  );

  it('quotes no price', () => {
    // These rows are free, and every rate in this product is per-caller.
    expect(markup).not.toMatch(/\$\d/);
  });

  it('carries no em-dashes, en-dashes, asterisks or emoji', () => {
    expect(markup).not.toMatch(/[—–*]/);
    expect(markup).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});
