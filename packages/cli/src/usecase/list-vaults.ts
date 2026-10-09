import { resolveAuth } from "../infra/config/credentials";
import { resolveServerUrl } from "../infra/config/server-url";
import { RestApi } from "../infra/http/api-client";

export async function listVaults(server: string | undefined, env: NodeJS.ProcessEnv) {
  const serverUrl = resolveServerUrl(server, env);
  const auth = await resolveAuth(serverUrl, env);
  const api = new RestApi(serverUrl, auth, crypto.randomUUID(), "");

  const vaults = await api.vaults();

  return { vaults };
}
