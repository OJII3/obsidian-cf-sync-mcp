import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import * as v from "valibot";

const nonempty = v.pipe(v.string(), v.minLength(1));
const bindingSchema = v.object({
  serverUrl: nonempty,
  vaultId: nonempty,
  deviceId: nonempty,
});
const credentialsSchema = v.object({ clientId: nonempty, clientSecret: nonempty });

type Binding = v.InferOutput<typeof bindingSchema>;
type Credentials = v.InferOutput<typeof credentialsSchema>;

export interface McpConfig {
  binding: Binding;
  credentials: Credentials;
}

export async function loadConfig(env: NodeJS.ProcessEnv): Promise<McpConfig> {
  const directory = env["CF_SYNC_VAULT_DIR"];
  if (!directory) {
    throw new Error("Set CF_SYNC_VAULT_DIR to an initialized CF Sync directory");
  }

  const bindingPath = resolve(directory, ".cf-sync", "vault.json");
  const binding = v.parse(bindingSchema, JSON.parse(await readFile(bindingPath, "utf8")));
  const server = new URL(binding.serverUrl);
  const isLocalHttp =
    server.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(server.hostname);
  if (server.protocol !== "https:" && !isLocalHttp) {
    throw new Error("CF Sync server URL must use HTTPS (HTTP is allowed for localhost)");
  }
  if (
    server.pathname !== "/" ||
    server.search ||
    server.hash ||
    server.username ||
    server.password
  ) {
    throw new Error("CF Sync server URL must contain only an origin");
  }
  binding.serverUrl = server.origin;

  const credentials = v.parse(credentialsSchema, {
    clientId: env["CF_ACCESS_CLIENT_ID"],
    clientSecret: env["CF_ACCESS_CLIENT_SECRET"],
  });

  return { binding, credentials };
}
