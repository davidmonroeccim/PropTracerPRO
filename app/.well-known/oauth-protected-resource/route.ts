import { protectedResourceHandler } from "mcp-handler";

const handler = protectedResourceHandler({
  // The gateway Supabase is the authorization server (SUITE_ISSUER = <gateway supabase>/auth/v1).
  authServerUrls: [process.env.SUITE_ISSUER!.replace(/\/auth\/v1\/?$/, "") + "/auth/v1"],
});

export { handler as GET };
