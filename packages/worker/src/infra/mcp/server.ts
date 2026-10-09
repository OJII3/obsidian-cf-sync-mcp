import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { Account } from "../durable-objects/account";
import type { Vault } from "../durable-objects/vault";

import { ReadonlyVaultApi } from "./api";

export function createServer(
  account: DurableObjectStub<Account>,
  vaults: DurableObjectNamespace<Vault>,
): McpServer {
  const server = new McpServer({ name: "obsidian-cf-sync", version: "0.3.1" });
  const api = new ReadonlyVaultApi(account, vaults);

  registerListVaults(server, api);
  registerListNotes(server, api);
  registerReadNote(server, api);
  registerSearchNotes(server, api);

  return server;
}

function registerListVaults(server: McpServer, api: ReadonlyVaultApi): void {
  server.registerTool(
    "list_vaults",
    {
      title: "List Vaults",
      description: "List remote Vaults registered in CF Sync.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(await api.listVaults()) }],
    }),
  );
}

function registerListNotes(server: McpServer, api: ReadonlyVaultApi): void {
  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description:
        "List Markdown notes in a CF Sync Vault. If only one Vault exists, vaultId can be omitted.",
      inputSchema: { vaultId: z.string().uuid().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ vaultId }) => {
      const files = await api.listFiles(await api.resolveVaultId(vaultId));
      const notes = files
        .filter((file) => file.kind === "text")
        .map(({ path, size, conflict }) => ({ path, size, conflict }));

      return { content: [{ type: "text" as const, text: JSON.stringify(notes) }] };
    },
  );
}

function registerReadNote(server: McpServer, api: ReadonlyVaultApi): void {
  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description: "Read a Markdown note by its exact path in a CF Sync Vault.",
      inputSchema: { path: z.string().min(1), vaultId: z.string().uuid().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, vaultId }) => {
      const resolvedVaultId = await api.resolveVaultId(vaultId);
      const file = (await api.listFiles(resolvedVaultId)).find((entry) => entry.path === path);
      if (!file) {
        throw new Error(`Note not found: ${path}`);
      }
      if (file.kind !== "text") {
        throw new Error(`Path is not a Markdown note: ${path}`);
      }

      const text = await api.readText(resolvedVaultId, file.id);
      return { content: [{ type: "text" as const, text }] };
    },
  );
}

function registerSearchNotes(server: McpServer, api: ReadonlyVaultApi): void {
  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Search note contents for a literal, case-insensitive phrase. Searches remote notes on demand and may take time for large Vaults.",
      inputSchema: {
        query: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(50).default(20),
        vaultId: z.string().uuid().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit, vaultId }) => {
      const resolvedVaultId = await api.resolveVaultId(vaultId);
      const files = (await api.listFiles(resolvedVaultId)).filter((file) => file.kind === "text");
      const matches: { path: string; snippet: string }[] = [];
      const needle = query.toLocaleLowerCase();

      for (let offset = 0; offset < files.length && matches.length < limit; offset += 4) {
        const batch = files.slice(offset, offset + 4);
        const results = await Promise.all(
          batch.map(async (file) => ({ file, text: await api.readText(resolvedVaultId, file.id) })),
        );

        for (const { file, text } of results) {
          const index = text.toLocaleLowerCase().indexOf(needle);
          if (index < 0) {
            continue;
          }

          const start = Math.max(0, index - 100);
          const end = Math.min(text.length, index + query.length + 180);
          matches.push({ path: file.path, snippet: text.slice(start, end) });
          if (matches.length >= limit) {
            break;
          }
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ matches, truncated: matches.length >= limit }),
          },
        ],
      };
    },
  );
}
