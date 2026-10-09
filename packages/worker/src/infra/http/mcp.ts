import { insufficientScope, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "@modelcontextprotocol/server";

import type { Env } from "../env";
import { createServer } from "../mcp/server";

const requiredScope = "notes:read";

export function handleMcpRequest(
  request: Request,
  env: Env,
  ctx: OAuthResourceContext<unknown>,
): Promise<Response> {
  if (!ctx.auth.scope.includes(requiredScope)) {
    return Promise.resolve(insufficientScope(ctx.auth, [requiredScope]));
  }

  const handler = createMcpHandler(() => createServer(env.ACCOUNT.getByName("owner"), env.VAULTS));

  return handler.fetch(request);
}
