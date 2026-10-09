import { defineCommand } from "citty";

import { resolveServerUrl } from "../../infra/config/server-url";
import { login } from "../../usecase/login";
import type { CliContext } from "../context";

export function createAuthCommand(context: CliContext) {
  const loginCommand = defineCommand({
    meta: { name: "login", description: "Sign in to Cloudflare Access in a browser" },
    args: {
      server: { type: "string", description: "Server URL (or CF_SYNC_SERVER_URL)" },
    },
    async run({ args }) {
      const serverUrl = resolveServerUrl(args.server, context.env);
      await login(serverUrl);
      context.output(`Signed in to ${serverUrl}`);
    },
  });

  return defineCommand({
    meta: { name: "auth", description: "Manage Cloudflare Access login" },
    subCommands: { login: loginCommand },
  });
}
