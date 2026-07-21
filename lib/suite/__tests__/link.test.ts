import { describe, expect, test } from "vitest";
import { ALREADY_LINKED_ELSEWHERE, decideLink, EMAIL_NOT_VERIFIED_REASON } from "@/lib/suite/link";

const claims = (over = {}) => ({ sub: "S1", email: "a@c.com", emailVerified: true, ...over });
const prof = (over = {}) => ({ id: "U1", gateway_sub: null as string | null, email: "a@c.com", ...over });

describe("decideLink", () => {
  test("unverified email -> refuse", () => {
    expect(decideLink(claims({ emailVerified: false }), null, null)).toEqual({
      action: "refuse",
      reason: EMAIL_NOT_VERIFIED_REASON,
    });
  });
  test("match by sub -> use (authoritative, ignores email)", () => {
    expect(decideLink(claims(), prof({ id: "U9", gateway_sub: "S1", email: "old@c.com" }), null)).toEqual({
      action: "use",
      userId: "U9",
      email: "old@c.com",
    });
  });
  test("email match, no sub yet -> link", () => {
    expect(decideLink(claims(), null, prof())).toEqual({ action: "link", userId: "U1", email: "a@c.com" });
  });
  test("email match with a DIFFERENT sub -> refuse (never re-point)", () => {
    expect(decideLink(claims(), null, prof({ gateway_sub: "OTHER" }))).toEqual({
      action: "refuse",
      reason: ALREADY_LINKED_ELSEWHERE,
    });
  });
  test("no match -> create", () => {
    expect(decideLink(claims(), null, null)).toEqual({ action: "create" });
  });
});
