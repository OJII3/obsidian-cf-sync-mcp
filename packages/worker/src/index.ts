import { OAuthProvider, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";

import type { Env } from "./infra/env";
import { apiRoutes } from "./infra/http/api-routes";
import { handleMcpRequest } from "./infra/http/mcp";
import { handleMcpAuthorization } from "./infra/http/mcp-authorization";
import { oauthCallback } from "./infra/http/oauth-callback";
import { notFound, onError } from "./infra/http/responses";
import { routeWebSocket } from "./infra/http/websocket-route";
import { OAuthStorage } from "./infra/oauth-storage";

export { Account as AccountDO } from "./infra/durable-objects/account";
export { Vault as VaultDO } from "./infra/durable-objects/vault";

const app = new Hono<{ Bindings: Env }>();

app.onError(onError);
app.notFound(notFound);

app.get("/oauth/callback", jsxRenderer(), oauthCallback);
app.route("/api", apiRoutes);
app.get("/ws", routeWebSocket);

const defaultHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === "/authorize") {
      return handleMcpAuthorization(request, env);
    }

    return app.fetch(request, env, ctx);
  },
};

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const issuer = new URL(request.url).origin;
    const provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: {
        fetch: (mcpRequest, bindings, context) =>
          handleMcpRequest(mcpRequest, bindings, context as OAuthResourceContext<unknown>),
      },
      defaultHandler,
      authorizeEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/oauth/token`,
      clientRegistrationEndpoint: `${issuer}/oauth/register`,
      scopesSupported: ["notes:read"],
      requiredScopes: ["notes:read"],
      clientIdMetadataDocumentEnabled: true,
      resourceMetadata: {
        resource: `${issuer}/mcp`,
        authorization_servers: [issuer],
      },
    });

    const oauthEnv = {
      ...env,
      OAUTH_KV: new OAuthStorage(env.ACCOUNT.getByName("owner")),
    } as Env;
    return provider.fetch(request, oauthEnv, ctx);
  },
};
