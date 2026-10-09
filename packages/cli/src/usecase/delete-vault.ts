import { resolveAuth } from "../infra/config/credentials";
import { resolveServerUrl } from "../infra/config/server-url";
import { RestApi } from "../infra/http/api-client";

export async function deleteVault(
  server: string | undefined,
  env: NodeJS.ProcessEnv,
  id: string,
  expectedName: string,
) {
  const serverUrl = resolveServerUrl(server, env);
  const auth = await resolveAuth(serverUrl, env);
  const api = new RestApi(serverUrl, auth, crypto.randomUUID(), "");
  const vault = (await api.vaults()).find((item) => item.id === id);

  if (!vault) {
    throw new Error(`Vault not found: ${id}`);
  }
  if (vault.name !== expectedName) {
    throw new Error("Vault changed before deletion; run the command again");
  }

  await api.deleteVault(id);

  return { vault };
}
