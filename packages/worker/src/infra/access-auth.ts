import { createRemoteJWKSet, jwtVerify } from "jose";

import { ApplicationError } from "../domain/errors";

import type { Env } from "./env";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticate(request: Request, env: Env): Promise<void> {
  await verifyAccessAssertion(request, env);
}

export async function getAuthenticatedUserId(request: Request, env: Env): Promise<string> {
  const subject = await verifyAccessAssertion(request, env);
  if (!subject) {
    throw new ApplicationError("unauthenticated", "Invalid Access identity");
  }
  return subject;
}

async function verifyAccessAssertion(request: Request, env: Env): Promise<string | undefined> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new ApplicationError("unavailable", "Access is not configured");
  }

  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");

  if (!assertion) {
    throw new ApplicationError("unauthenticated", "Access assertion required");
  }

  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  let keys = keySets.get(issuer);

  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    keySets.set(issuer, keys);
  }

  try {
    const { payload } = await jwtVerify(assertion, keys, {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "sub"],
    });

    return payload.sub;
  } catch {
    throw new ApplicationError("unauthenticated", "Invalid Access identity");
  }
}
