import { expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import SingleTracePage from '@/app/(dashboard)/trace/single/page';

/**
 * The wiring test. FullTraceDisclosure.test.tsx proves the disclosure is
 * correct and PropertyRecordCard.test.tsx proves the panel is; this proves the
 * page actually renders them, that the owner name field genuinely accepts a
 * blank submit, and that AI Search is gone from the surface.
 *
 * A static render is the whole harness: no jsdom, no testing-library, no new
 * dependency. Effects do not run, so the profile is still null here and the
 * copy is the no-figure variant -- which is itself the state a real user sees
 * for the first moment of every page load, so it is worth pinning.
 */
const markup = renderToStaticMarkup(<SingleTracePage />);

test('the owner name field starts blank, so the disclosure is on screen from the first paint', () => {
  expect(markup).toContain('data-testid="full-trace-disclosure"');
  expect(markup).toContain('Full Property Trace');
});

test('the disclosure is inline in the form, not behind a click', () => {
  // It renders inside the form markup rather than in a dialog that has to be
  // opened. If this ever moves behind a trigger, the user can submit without
  // having seen the price.
  const form = markup.slice(markup.indexOf('<form'), markup.indexOf('</form>'));
  expect(form).toContain('full-trace-disclosure');
});

test('the owner name input is not `required`, so a blank submit is reachable', () => {
  // The browser used to refuse the submit outright, which made the tier the API
  // charges for unreachable from this page. If `required` comes back, the
  // disclosure below it is describing something that cannot happen.
  const ownerInput = markup.slice(markup.indexOf('id="owner"'));
  expect(ownerInput.slice(0, ownerInput.indexOf('>'))).not.toContain('required');
});

test('the owner name label no longer claims the field is required', () => {
  expect(markup).not.toContain('Owner Name *');
  expect(markup).not.toContain('Required for skip trace');
});

test('the property record opt-in is in the form, next to the price', () => {
  const form = markup.slice(markup.indexOf('<form'), markup.indexOf('</form>'));
  expect(form).toContain('data-testid="full-property-trace-toggle"');
  expect(form).toContain('Pull the full property record');
});

test('with the owner name blank the opt-in is ticked and locked', () => {
  // A blank owner name already routes to tier 2 on the route's own predicate.
  // An unticked box beside a disclosure that says the property record IS
  // included would contradict it, and a box the user could untick would be a
  // control over something they do not control.
  const toggle = markup.slice(markup.indexOf('data-testid="full-property-trace-toggle"'));
  const tag = toggle.slice(0, toggle.indexOf('>'));
  expect(tag).toContain('checked');
  expect(tag).toContain('disabled');
});

test('AI Search is gone from the page', () => {
  // Its button offered a second price, and the card it rendered claimed
  // "Free (no owner found)", which per-record billing made false.
  expect(markup).not.toContain('AI Search');
  expect(markup).not.toMatch(/AI [Rr]esearch/);
  expect(markup).not.toContain('Free (no owner found)');
});

test('the only price the empty page can show is the tier 2 one it derives', () => {
  // The profile has not loaded in a static render, so the disclosure quotes no
  // figure. Any dollar amount on screen here is a hardcoded one.
  expect(markup).not.toMatch(/\$\d/);
});
