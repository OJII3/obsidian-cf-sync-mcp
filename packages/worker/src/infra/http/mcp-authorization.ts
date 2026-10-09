import {
  AuthorizationError,
  CimdFetchError,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";

import { ApplicationError } from "../../domain/errors";
import { getAuthenticatedUserId } from "../access-auth";
import type { Env } from "../env";

const scope = "notes:read";

export async function handleMcpAuthorization(request: Request, env: Env): Promise<Response> {
  try {
    const userId = await getAuthenticatedUserId(request, env);
    if (request.method === "GET") {
      return showConsent(request, env);
    }
    if (request.method === "POST") {
      return submitConsent(request, env, userId);
    }

    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      let message = "This client could not be verified.";
      if (error instanceof AuthorizationError) {
        message = error.description;
      }
      return new Response(message, {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (error instanceof ApplicationError && error.kind === "unauthenticated") {
      return new Response("Sign in through Cloudflare Access to authorize this MCP client.", {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      });
    }
    throw error;
  }
}

async function showConsent(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  consent.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  consent.headers.set("Cache-Control", "no-store");
  return new Response(renderConsentPage(details, consent.handle), { headers: consent.headers });
}

async function submitConsent(request: Request, env: Env, userId: string): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handleField = form.get("handle");
  let handle = "";
  if (typeof handleField === "string") {
    handle = handleField;
  }
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    denied.headers.set("Cache-Control", "no-store");
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const approved = await oauth.approveConsent(request, handle, {
    scope: form.getAll("scope").filter((value): value is string => typeof value === "string"),
  });
  const authorization = await oauth.completeAuthorization({
    request: approved.request,
    userId,
    metadata: {},
    scope: approved.request.scope,
    props: { userId },
  });
  approved.headers.set("Location", authorization.redirectTo);
  approved.headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers: approved.headers });
}

function renderConsentPage(details: ConsentDescription, handle: string): string {
  const clientName = escapeHtml(details.clientName);
  let clientDomain = "<p>This client has not verified its publisher domain.</p>";
  if (details.clientDomain) {
    clientDomain = `<p>Verified publisher: <strong>${escapeHtml(details.clientDomain)}</strong></p>`;
  }
  const scopes = details.scope
    .map((requestedScope) => {
      let label = `Requested permission: ${escapeHtml(requestedScope)}`;
      if (requestedScope === scope) {
        label = "Read notes in this CF Sync Vault";
      }
      return `<label><input type="checkbox" name="scope" value="${escapeHtml(requestedScope)}" checked> ${label}</label>`;
    })
    .join("<br>");
  let loopbackWarning = "";
  if (details.redirectIsLoopback) {
    loopbackWarning =
      "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>";
  }

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${clientName}</title>
<h1>Allow ${clientName} to access CF Sync?</h1>
${clientDomain}
<p>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopbackWarning}
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  ${scopes}
  <p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p>
</form>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}
