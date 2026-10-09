import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import * as v from "valibot";

import { credentialsSchema, type CliAuth, type Credentials } from "../../domain/credentials";

import { readConfig } from "./config-file";

const execFile = promisify(execFileCallback);

export function requireEnvironmentCredentials(env: NodeJS.ProcessEnv): Credentials {
  return v.parse(credentialsSchema, {
    clientId: env["CF_ACCESS_CLIENT_ID"],
    clientSecret: env["CF_ACCESS_CLIENT_SECRET"],
  });
}

export function readEnvironmentCredentials(env: NodeJS.ProcessEnv): Credentials | undefined {
  const hasClientId = env["CF_ACCESS_CLIENT_ID"] !== undefined;
  const hasClientSecret = env["CF_ACCESS_CLIENT_SECRET"] !== undefined;

  if (!hasClientId && !hasClientSecret) {
    return undefined;
  }

  return requireEnvironmentCredentials(env);
}

export async function resolveAuth(
  origin: string,
  env: NodeJS.ProcessEnv,
): Promise<CliAuth> {
  const environmentCredentials = readEnvironmentCredentials(env);

  if (environmentCredentials) {
    return { method: "service-token", credentials: environmentCredentials };
  }

  try {
    const accessUrl = new URL("/api/vaults", origin).toString();
    const { stdout } = await execFile("cloudflared", ["access", "token", `-app=${accessUrl}`], {
      timeout: 10_000,
    });
    const token = stdout.trim();
    if (token) {
      return { method: "access-token", token };
    }
  } catch {
    // Fall back to a configured Service Token when no cloudflared session is available.
  }

  const config = await readConfig(env);
  const stored = config[origin];

  if (!stored) {
    throw new Error(
      `No Cloudflare Access session for ${origin}. Run "obsidian-cf-sync auth login --server ${origin}" or configure a Service Token.`,
    );
  }

  return { method: "service-token", credentials: stored };
}
