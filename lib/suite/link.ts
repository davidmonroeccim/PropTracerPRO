import { createAdminClient } from "@/lib/supabase/admin";
import { alertSuite } from "./alert";
import type { SuiteClaims } from "./verify";

export interface MatchedProfile {
  id: string;
  gateway_sub: string | null;
  email: string;
}

/** The PTP account gateway claims resolved to. `email` is the RESOLVED ACCOUNT's own email,
 *  never claims.email (they diverge when a linked user changes their gateway email). */
export interface SuiteIdentity {
  userId: string;
  email: string;
}

export type LinkDecision =
  | { action: "use"; userId: string; email: string }
  | { action: "link"; userId: string; email: string }
  | { action: "create" }
  | { action: "refuse"; reason: string };

export const ALREADY_LINKED_ELSEWHERE =
  "This PropTracerPRO account is already linked to a different Suite Gateway identity.";
const LOOKUP_FAILED = "Could not verify your PropTracerPRO account right now. Please try again.";
export const EMAIL_NOT_VERIFIED_REASON =
  "The Suite Gateway did not confirm this email address as verified.";

/**
 * The linking rule. Pure, so every branch is testable.
 * 1. email_verified must be exactly true, or refuse.
 * 2. gateway_sub is authoritative once set (a changed gateway email never re-links elsewhere).
 * 3. An email matching an account already claimed by a different gateway_sub is refused (takeover).
 * Every non-refusing decision carries the MATCHED ACCOUNT's email, not the claim's.
 */
export function decideLink(
  claims: SuiteClaims,
  bySub: MatchedProfile | null,
  byEmail: MatchedProfile | null,
): LinkDecision {
  if (!claims.emailVerified) return { action: "refuse", reason: EMAIL_NOT_VERIFIED_REASON };
  if (bySub) return { action: "use", userId: bySub.id, email: bySub.email };
  if (byEmail) {
    if (byEmail.gateway_sub && byEmail.gateway_sub !== claims.sub) {
      return { action: "refuse", reason: ALREADY_LINKED_ELSEWHERE };
    }
    return { action: "link", userId: byEmail.id, email: byEmail.email };
  }
  return { action: "create" };
}

export class SuiteLinkError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SuiteLinkError";
  }
}

function deny(kind: "refused" | "failed", reason: string, context: Record<string, string>): never {
  console.error(`[suite-signin] ${kind}:`, reason, context);
  alertSuite(kind, reason, context);
  throw new SuiteLinkError(reason);
}
function refuse(reason: string, context: Record<string, string>): never {
  deny("refused", reason, context);
}
function fail(reason: string, context: Record<string, string>): never {
  deny("failed", reason, context);
}

/** Resolve verified gateway claims to a PTP account, linking or creating as needed.
 *  Returns the RESOLVED ACCOUNT's identity; callers must mint from THAT, never claims.email. */
export async function resolveSuiteUser(claims: SuiteClaims): Promise<SuiteIdentity> {
  const admin = createAdminClient();

  const { data: bySub, error: bySubErr } = await admin
    .from("user_profiles")
    .select("id, gateway_sub, email")
    .eq("gateway_sub", claims.sub)
    .maybeSingle();
  if (bySubErr) fail(LOOKUP_FAILED, { sub: claims.sub, lookup: "sub", code: bySubErr.code });

  // Exact match, and it MUST stay exact (both sides already lowercase). NEVER .ilike(): PostgREST
  // passes the value straight into a SQL LIKE pattern, so `_`/`%` in an attacker's gateway email
  // become wildcards -> a verified john_doe@corp.com matches victim john.doe@corp.com = takeover.
  const { data: byEmail, error: byEmailErr } = await admin
    .from("user_profiles")
    .select("id, gateway_sub, email")
    .eq("email", claims.email)
    .maybeSingle();
  if (byEmailErr) fail(LOOKUP_FAILED, { sub: claims.sub, lookup: "email", code: byEmailErr.code });

  const decision = decideLink(claims, bySub as MatchedProfile | null, byEmail as MatchedProfile | null);

  switch (decision.action) {
    case "refuse":
      return refuse(decision.reason, { sub: claims.sub });
    case "use":
      return { userId: decision.userId, email: decision.email };
    case "link": {
      const { data: linked, error } = await (admin.from("user_profiles") as any)
        .update({ gateway_sub: claims.sub })
        .eq("id", decision.userId)
        .is("gateway_sub", null)
        .select("id");
      if (error) {
        fail("Could not link this account. Please try again.", {
          sub: claims.sub,
          userId: decision.userId,
          code: error.code,
        });
      }
      if (!linked?.length) {
        const { data: current, error: rereadErr } = await (admin.from("user_profiles") as any)
          .select("gateway_sub")
          .eq("id", decision.userId)
          .maybeSingle();
        if (rereadErr) {
          fail(LOOKUP_FAILED, {
            sub: claims.sub,
            userId: decision.userId,
            lookup: "race-reread",
            code: rereadErr.code,
          });
        }
        if (current?.gateway_sub !== claims.sub) {
          refuse(ALREADY_LINKED_ELSEWHERE, { sub: claims.sub, userId: decision.userId });
        }
      }
      return { userId: decision.userId, email: decision.email };
    }
    case "create": {
      const { data: created, error } = await admin.auth.admin.createUser({
        email: claims.email,
        email_confirm: true, // the gateway already proved they control it
      });
      if (error || !created.user) {
        fail("Could not create your PropTracerPRO account. Please try again.", {
          sub: claims.sub,
          code: error?.code ?? "no_user_returned",
        });
      }

      // handle_new_user() should have made the (wallet-tier) profile row. Confirm the pin landed.
      const { data: pinned, error: linkErr } = await (admin.from("user_profiles") as any)
        .update({ gateway_sub: claims.sub })
        .eq("id", created!.user!.id)
        .select("id");
      if (linkErr) {
        fail("Could not link your new account. Please try again.", {
          sub: claims.sub,
          userId: created!.user!.id,
          code: linkErr.code,
        });
      }

      // Zero rows means the trigger silently failed; heal it rather than strand a confirmed
      // auth.users row (the retry would find the email taken and lock the user out forever).
      if (!pinned?.length) {
        const { error: healErr } = await (admin.from("user_profiles") as any).upsert(
          { id: created!.user!.id, email: claims.email, gateway_sub: claims.sub },
          { onConflict: "id" },
        );
        if (healErr) {
          fail("Could not finish setting up your PropTracerPRO account. Please try again.", {
            sub: claims.sub,
            userId: created!.user!.id,
            code: healErr.code,
            healed: "false",
          });
        }
        alertSuite("trigger_missed", "profile trigger missed, row healed in app", {
          userId: created!.user!.id,
          sub: claims.sub,
        });
      }
      return { userId: created!.user!.id, email: claims.email };
    }
  }
}
