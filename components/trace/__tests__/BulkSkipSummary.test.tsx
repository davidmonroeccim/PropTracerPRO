import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BulkSkipSummary } from '@/components/trace/BulkSkipSummary';
import { BLANK_OWNER_SKIP_REASON } from '@/lib/trace/blankOwnerSkip';
import { ENTITY_TRACE_FAILED_REASON } from '@/lib/trace/entityTraceAttempts';

/**
 * The job-summary half of David's blank-owner rule: accept the file, skip the
 * row with a reason, charge nothing, and say so on screen as well as in the CSV.
 *
 * A static render is the whole harness, as it is for FullTraceDisclosure: this
 * component holds no state and runs no effects.
 */

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
    expect(markup).toContain('We skipped 40 of your records');
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
    expect(one).toContain('We skipped 1 of your records');
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
    expect(noReason).toContain('We skipped 3 of your records');
    expect(noReason).not.toContain('not charged');
    expect(noReason).not.toContain('owner');
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
