import { afterEach, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  vi.restoreAllMocks();
});

test("callback returns 404 and clears cookies when the flag is off", async () => {
  delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  const { GET } = await import("@/app/api/auth/suite/callback/route");
  const req = new NextRequest("https://proptracerpro.com/api/auth/suite/callback?code=x&state=y");
  const res = await GET(req);
  expect(res.status).toBe(404);
  expect(res.cookies.get("suite_state")?.value).toBe("");
});

test("start returns 404 when the flag is off", async () => {
  delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  const { GET } = await import("@/app/api/auth/suite/start/route");
  const res = await GET();
  expect(res.status).toBe(404);
});
