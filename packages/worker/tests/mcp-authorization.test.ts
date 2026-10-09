import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/infra/env";
import { handleMcpAuthorization } from "../src/infra/http/mcp-authorization";

vi.mock("../src/infra/access-auth", () => ({
  getAuthenticatedUserId: async () => "owner",
}));

const issuer = "https://sync.example.com";

async function setup(redirectUri: string) {
  const records = new Map<string, string>();
  const env = {
    OAUTH_KV: {
      get: async (key: string, options?: { type?: string }) => {
        const value = records.get(key);
        if (value === undefined) return null;
        return options?.type === "json" ? (JSON.parse(value) as unknown) : value;
      },
      put: async (key: string, value: string) => {
        records.set(key, value);
      },
      delete: async (key: string) => {
        records.delete(key);
      },
      list: async (options: { prefix?: string }) => ({
        keys: [...records.keys()]
          .filter((name) => name.startsWith(options.prefix ?? ""))
          .map((name) => ({ name })),
        list_complete: true,
      }),
    },
  } as unknown as Env;
  const provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: { fetch: async () => new Response(null) },
    defaultHandler: { fetch: handleMcpAuthorization },
    authorizeEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/oauth/token`,
    clientRegistrationEndpoint: `${issuer}/oauth/register`,
    scopesSupported: ["notes:read"],
    resourceMetadata: { resource: `${issuer}/mcp`, authorization_servers: [issuer] },
  });
  const request = (path: string, init?: RequestInit) =>
    provider.fetch(new Request(`${issuer}${path}`, init), env, {} as ExecutionContext);
  const registration = await request("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "pi",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    }),
  });
  const { client_id: clientId } = (await registration.json()) as { client_id: string };
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
    state: "request-state",
    scope: "notes:read",
    resource: `${issuer}/mcp`,
  });
  const consent = await request(`/authorize?${query.toString()}`);
  const html = await consent.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1] ?? "";
  const cookie = consent.headers.get("Set-Cookie")?.split(";")[0] ?? "";
  expect(consent.status).toBe(200);
  expect(handle).not.toBe("");
  expect(cookie).toContain("__Host-oauth-consent-");

  const submit = (decision: string, cookies = `CF_Authorization=access, ${cookie}`) =>
    request("/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies },
      body: new URLSearchParams({ handle, decision, scope: "notes:read" }).toString(),
    });

  return { consent, submit, request };
}

describe("MCP authorization", () => {
  it.each([
    "http://127.0.0.1:44699/callback",
    "http://[::1]:44699/callback",
    "https://client.example.com/callback?return_to=notes",
  ])("permits the validated callback origin in the form redirect policy: %s", async (uri) => {
    const { consent } = await setup(uri);
    expect(consent.headers.get("Content-Security-Policy")).toBe(
      `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(uri).origin}; base-uri 'none'; frame-ancestors 'none'`,
    );
  });

  it.each(["approve", "deny"])(
    "redirects after %s with duplicate Cookie headers and reports a repeated submission locally",
    async (decision) => {
      const uri = "http://127.0.0.1:44699/callback";
      const { submit } = await setup(uri);
      const response = await submit(decision);
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location") ?? "");
      expect(`${location.origin}${location.pathname}`).toBe(uri);
      expect(location.searchParams.get("state")).toBe("request-state");
      expect(location.searchParams.has(decision === "approve" ? "code" : "error")).toBe(true);
      expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");

      const repeated = await submit(decision, "CF_Authorization=access");
      expect(repeated.status).toBe(400);
      expect(await repeated.text()).toBe(
        "This authorization was not started in this browser; start again",
      );
    },
  );

  it("handles an invalid authorization GET without an uncaught rejection", async () => {
    const { request } = await setup("http://127.0.0.1:44699/callback");
    expect((await request("/authorize")).status).toBe(400);
  });
});
