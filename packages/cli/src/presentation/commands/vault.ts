import { createInterface } from "node:readline/promises";

import { defineCommand } from "citty";

import { deleteVault } from "../../usecase/delete-vault";
import { listVaults } from "../../usecase/list-vaults";
import type { CliContext } from "../context";
import { writeOutput } from "../output";

export function createVaultCommand(context: CliContext) {
  const list = defineCommand({
    meta: { name: "list", description: "List existing remote Vaults" },
    args: {
      server: { type: "string", description: "Server URL (or CF_SYNC_SERVER_URL)" },
      json: { type: "boolean", description: "Write a JSON result" },
    },
    async run({ args }) {
      const result = await listVaults(args.server, context.env);
      const text = result.vaults.map((vault) => `${vault.id}\t${vault.name}`).join("\n");

      writeOutput(context, args.json, result, text);
    },
  });

  const remove = defineCommand({
    meta: { name: "delete", description: "Permanently delete a remote Vault and its data" },
    args: {
      id: { type: "positional", required: true, description: "Remote Vault ID" },
      server: { type: "string", description: "Server URL (or CF_SYNC_SERVER_URL)" },
      yes: { type: "boolean", description: "Confirm permanent deletion without prompting" },
      json: { type: "boolean", description: "Write a JSON result" },
    },
    async run({ args }) {
      const { vaults } = await listVaults(args.server, context.env);
      const vault = vaults.find((item) => item.id === args.id);
      if (!vault && !args.yes) {
        throw new Error(
          `Vault not found in the list. If a previous deletion failed, retry with --yes: ${args.id}`,
        );
      }

      if (vault && !args.yes) {
        if (args.json || !process.stdin.isTTY) {
          throw new Error("Deletion requires confirmation; pass --yes to confirm");
        }
        context.output(
          `Permanently delete Vault "${vault.name}" (${vault.id}) and all its remote data.`,
        );
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = await prompt.question(`Type ${vault.name} to confirm: `);
          if (answer.trim() !== vault.name) {
            throw new Error("Vault name did not match; deletion cancelled");
          }
        } finally {
          prompt.close();
        }
      }

      const result = await deleteVault(args.server, context.env, args.id, vault?.name);
      const name = result.name ?? args.id;
      writeOutput(
        context,
        args.json,
        { deleted: true, id: result.id, name: result.name ?? null },
        `Deleted Vault ${name} (${result.id})`,
      );
    },
  });

  return defineCommand({
    meta: { name: "vault", description: "Manage the remote Vault connection" },
    subCommands: { list, delete: remove },
  });
}
