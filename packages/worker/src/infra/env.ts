import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

import type { Account } from "./durable-objects/account";
import type { Vault } from "./durable-objects/vault";

export interface Env {
  ACCOUNT: DurableObjectNamespace<Account>;
  VAULTS: DurableObjectNamespace<Vault>;
  BUCKET: R2Bucket;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  MCP_PUBLIC_URL: string;
  MCP_VAULT_ID: string;
  MCP_DEVICE_ID: string;
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;
}
