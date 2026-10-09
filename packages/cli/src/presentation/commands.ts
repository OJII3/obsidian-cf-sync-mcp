import { defineCommand } from "citty";

import { createAuthCommand } from "./commands/auth";
import { createConfigCommand } from "./commands/config";
import { createInitCommand } from "./commands/init";
import { createSyncCommand } from "./commands/sync";
import { createVaultCommand } from "./commands/vault";
import type { CliContext } from "./context";

export function createCommands(context: CliContext) {
  return defineCommand({
    meta: { name: "obsidian-cf-sync", description: "Synchronize a Vault without Obsidian" },
    subCommands: {
      config: createConfigCommand(context),
      auth: createAuthCommand(context),
      vault: createVaultCommand(context),
      init: createInitCommand(context),
      sync: createSyncCommand(context),
    },
  });
}
