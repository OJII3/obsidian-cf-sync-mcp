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
      return await showConsent(request, env);
    }
    if (request.method === "POST") {
      return await submitConsent(request, env, userId);
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
  const redirectOrigin = new URL(details.redirectUri).origin;
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  // Chromium also checks form-action on the redirect after a form POST.
  consent.headers.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigin}; base-uri 'none'; frame-ancestors 'none'`,
  );
  consent.headers.set("Cache-Control", "no-store");
  return new Response(renderConsentPage(details, consent.handle), { headers: consent.headers });
}

async function submitConsent(request: Request, env: Env, userId: string): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const consentRequest = normalizeCookieHeader(request);
  const form = await consentRequest.formData();
  const handleField = form.get("handle");
  let handle = "";
  if (typeof handleField === "string") {
    handle = handleField;
  }
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(consentRequest, handle);
    denied.headers.set("Cache-Control", "no-store");
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const approved = await oauth.approveConsent(consentRequest, handle, {
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

function normalizeCookieHeader(request: Request): Request {
  const cookie = request.headers.get("cookie");
  if (!cookie || !cookie.includes(",")) {
    return request;
  }

  // Workers joins duplicate Cookie headers with commas; cookie parsers expect semicolons.
  const headers = new Headers(request.headers);
  headers.set("cookie", cookie.replace(/,\s*(?=[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/g, "; "));
  return new Request(request, { headers });
}

function renderConsentPage(details: ConsentDescription, handle: string): string {
  const clientName = escapeHtml(details.clientName);
  let clientDomain =
    '<p class="publisher unverified"><span class="status-dot" aria-hidden="true"></span>Publisher domain not verified</p>';
  if (details.clientDomain) {
    clientDomain = `<p class="publisher"><span class="status-dot" aria-hidden="true"></span>Verified publisher <strong>${escapeHtml(details.clientDomain)}</strong></p>`;
  }
  const scopes = details.scope
    .map((requestedScope) => {
      let label = `Requested permission: ${escapeHtml(requestedScope)}`;
      if (requestedScope === scope) {
        label = "Read notes in this CF Sync Vault";
      }
      return `<label class="permission"><input type="checkbox" name="scope" value="${escapeHtml(requestedScope)}" checked><span class="permission-icon" aria-hidden="true">▤</span><span><strong>${label}</strong><small>Access is limited to the permissions selected here.</small></span></label>`;
    })
    .join("");
  let loopbackWarning = "";
  if (details.redirectIsLoopback) {
    loopbackWarning = `<aside class="warning"><span aria-hidden="true">!</span><p><strong>This app is running on your computer.</strong><br>Continue only if you just started signing in from it.</p></aside>`;
  }

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${clientName}</title>
<meta name="color-scheme" content="light dark">
<style>
  :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-synthesis: none; text-rendering: optimizeLegibility; }
  * { box-sizing: border-box; }
  body { --ink: #182230; --muted: #667085; --line: #e4e7ec; --surface: #fff; --canvas: #f4f6f8; --accent: #176b55; --accent-hover: #125441; --soft: #f8faf9; margin: 0; min-height: 100vh; padding: 48px 20px; display: grid; place-items: center; color: var(--ink); background: radial-gradient(ellipse at 50% 0, #e5f2ed 0, var(--canvas) 48rem); }
  .card { width: min(100%, 480px); overflow: hidden; border: 1px solid rgba(16, 24, 40, .08); border-radius: 18px; background: var(--surface); box-shadow: 0 20px 60px rgba(16, 24, 40, .10); }
  .card-content { padding: 32px; }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 30px; color: var(--muted); font-size: 13px; font-weight: 650; letter-spacing: .02em; }
  .brand-mark { display: grid; width: 30px; height: 30px; place-items: center; border-radius: 9px; color: #fff; background: var(--accent); font-size: 15px; font-weight: 750; }
  h1 { margin: 0; font-size: clamp(24px, 5vw, 29px); line-height: 1.2; letter-spacing: -.035em; }
  .intro { margin: 12px 0 0; color: var(--muted); font-size: 15px; line-height: 1.55; }
  .client { display: flex; align-items: center; gap: 14px; margin-top: 26px; padding: 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--soft); }
  .client-mark { display: grid; flex: 0 0 42px; width: 42px; height: 42px; place-items: center; border: 1px solid var(--line); border-radius: 11px; color: var(--accent); background: var(--surface); font-size: 20px; }
  .client-copy { min-width: 0; }
  .client-name { overflow-wrap: anywhere; font-size: 15px; font-weight: 700; }
  .publisher { display: flex; align-items: center; gap: 6px; margin: 5px 0 0; color: var(--muted); font-size: 12px; }
  .publisher strong { overflow-wrap: anywhere; color: var(--ink); font-weight: 600; }
  .status-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: #12a36f; }
  .unverified .status-dot { background: #98a2b3; }
  .section-label { margin: 26px 0 10px; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; }
  .permission-list { overflow: hidden; border: 1px solid var(--line); border-radius: 12px; }
  .permission { display: flex; align-items: flex-start; gap: 12px; padding: 16px; cursor: pointer; }
  .permission input { width: 17px; height: 17px; flex: 0 0 17px; margin: 2px 0 0; accent-color: var(--accent); }
  .permission-icon { display: grid; width: 34px; height: 34px; flex: 0 0 34px; place-items: center; border-radius: 9px; color: var(--accent); background: #eaf4f0; font-size: 17px; }
  .permission strong { display: block; font-size: 14px; font-weight: 650; }
  .permission small { display: block; margin-top: 4px; color: var(--muted); font-size: 12px; line-height: 1.4; }
  .destination { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 18px 0 0; color: var(--muted); font-size: 13px; }
  .destination strong { overflow-wrap: anywhere; color: var(--ink); font-weight: 600; text-align: right; }
  .warning { display: flex; gap: 11px; margin-top: 18px; padding: 13px 14px; border: 1px solid #f2d28a; border-radius: 10px; color: #764b0b; background: #fff8e7; font-size: 12px; line-height: 1.5; }
  .warning > span { display: grid; width: 18px; height: 18px; flex: 0 0 18px; place-items: center; border-radius: 50%; color: #fff; background: #b7791f; font-weight: 800; }
  .warning p { margin: 0; }
  .actions { display: flex; gap: 10px; margin-top: 26px; }
  button { min-height: 46px; border: 1px solid transparent; border-radius: 10px; font: inherit; font-size: 14px; font-weight: 650; cursor: pointer; transition: background .15s ease, border-color .15s ease, transform .15s ease; }
  button:focus-visible, input:focus-visible { outline: 3px solid #78b8a2; outline-offset: 2px; }
  button:active { transform: translateY(1px); }
  .allow { flex: 1; color: #fff; background: var(--accent); }
  .allow:hover { background: var(--accent-hover); }
  .deny { padding: 0 18px; border-color: var(--line); color: var(--ink); background: var(--surface); }
  .deny:hover { background: var(--soft); }
  .footer { padding: 16px 24px; border-top: 1px solid var(--line); color: var(--muted); background: var(--soft); font-size: 11px; line-height: 1.5; text-align: center; }
  @media (max-width: 520px) { body { padding: 20px 12px; } .card { border-radius: 15px; } .card-content { padding: 25px 21px; } .brand { margin-bottom: 25px; } }
  @media (prefers-color-scheme: dark) { body { --ink: #edf2f7; --muted: #a0aec0; --line: #34404b; --surface: #202a34; --canvas: #111820; --accent: #55bd97; --accent-hover: #42a984; --soft: #26313b; background: radial-gradient(ellipse at 50% 0, #1c3932 0, var(--canvas) 48rem); } .card { border-color: #34404b; box-shadow: 0 20px 60px rgba(0, 0, 0, .28); } .brand-mark { color: #10251e; } .client-mark { color: var(--accent); } .permission-icon { color: #82d5b4; background: #263e37; } .allow { color: #10251e; } .warning { border-color: #785c2c; color: #f2d28a; background: #392f1e; } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; } }
</style>
<body>
  <main class="card" aria-labelledby="page-title">
    <div class="card-content">
      <div class="brand"><span class="brand-mark" aria-hidden="true">C</span><span>CF Sync</span></div>
      <h1 id="page-title">Connect ${clientName}?</h1>
      <p class="intro">Review what this app can access before connecting it to your vault.</p>
      <section class="client" aria-label="Application details">
        <span class="client-mark" aria-hidden="true">⌘</span>
        <div class="client-copy"><div class="client-name">${clientName}</div>${clientDomain}</div>
      </section>
      <p class="section-label">Requested access</p>
      <form method="post">
        <input type="hidden" name="handle" value="${escapeHtml(handle)}">
        <div class="permission-list">${scopes}</div>
        <p class="destination"><span>Redirect destination</span><strong>${escapeHtml(details.redirectHost)}</strong></p>
        ${loopbackWarning}
        <div class="actions">
          <button class="deny" name="decision" value="deny">Cancel</button>
          <button class="allow" name="decision" value="approve">Allow access</button>
        </div>
      </form>
    </div>
    <footer class="footer">Only approve apps you trust. You can revoke access at any time.</footer>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}
