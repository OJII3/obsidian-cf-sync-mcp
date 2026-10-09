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

  const serverUrl = new URL(env.MCP_PUBLIC_URL).origin;
  const handler = createMcpHandler(() =>
    createServer({
      binding: {
        serverUrl,
        vaultId: env.MCP_VAULT_ID,
        deviceId: env.MCP_DEVICE_ID,
      },
      credentials: {
        clientId: env.CF_ACCESS_CLIENT_ID,
        clientSecret: env.CF_ACCESS_CLIENT_SECRET,
      },
    }),
  );

  return handler.fetch(request);
}
