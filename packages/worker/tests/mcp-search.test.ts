import type { FileRecord } from "@cf-sync/protocol";
import { Hono } from "hono";
import { fromUint8Array } from "js-base64";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import type { Env } from "../src/infra/env";
import { mcpRoutes } from "../src/infra/http/mcp-routes";

function setup() {
  const vaultId = crypto.randomUUID();
  const doc = new Y.Doc();
  doc.getText("content").insert(0, "needle".padEnd(900000, "x"));
  const update = fromUint8Array(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  const files: FileRecord[] = ["a.md", "b.md", "c.md"].map((path) => ({
    id: crypto.randomUUID(),
    path,
    kind: "text",
    size: 900000,
    revision: 1,
    pathRevision: 1,
    digest: "test",
    conflict: false,
  }));
  const account = {
    vault: vi.fn(async () => ({ ok: true, value: { id: vaultId, name: "Vault" } })),
    registerDevice: vi.fn(async () => ({ ok: true, value: {} })),
  };
  const vault = {
    snapshot: vi.fn(async () => ({
      ok: true,
      value: Response.json({ revision: 1, r2Revision: 0, files, exclusions: [] }).body!,
    })),
    document: vi.fn(async (_vault: string, _device: string, id: string) => ({
      ok: true,
      value: Response.json({
        file: { ...files.find((file) => file.id === id), revision: 2 },
        content: { kind: "text", update },
      }).body!,
    })),
  };
  const env = {
    ACCOUNT: { getByName: () => account },
    VAULTS: { getByName: () => vault },
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>().route("/api", mcpRoutes);
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await app.request(
      "https://sync.test/api/mcp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: { vault_id: vaultId, ...args } },
        }),
      },
      env,
    );
    return (await response.json()) as { result: { structuredContent: Record<string, unknown> } };
  };
  return { vaultId, files, account, vault, call };
}

describe("bounded MCP search", () => {
  it("stays within the byte budget, uses one snapshot and reports the current text revision", async () => {
    const s = setup();
    const { result } = await s.call("search", { query: "needle" });
    expect(result.structuredContent["results"]).toEqual([
      expect.objectContaining({ title: "a.md", revision: 2 }),
      expect.objectContaining({ title: "b.md", revision: 2 }),
    ]);
    expect(result.structuredContent["next_cursor"]).toBe("b.md");
    expect(s.vault.document).toHaveBeenCalledTimes(2);
    expect(s.vault.snapshot).toHaveBeenCalledOnce();
    expect(s.account.registerDevice).toHaveBeenCalledOnce();
    const next = await s.call("search", { query: "needle", cursor: "b.md" });
    expect(next.result.structuredContent["results"]).toEqual([
      expect.objectContaining({ title: "c.md" }),
    ]);
    expect(next.result.structuredContent["next_cursor"]).toBeNull();
  });
  it("reports unscanned oversized text while retaining filename search", async () => {
    const s = setup();
    s.files[0]!.size = 2 * 1024 * 1024;
    const { result } = await s.call("search", { query: "a.md" });
    expect(result.structuredContent["skipped"]).toEqual(["a.md"]);
    expect(result.structuredContent["results"]).toEqual([
      expect.objectContaining({ title: "a.md", snippet: "" }),
    ]);
    expect(s.vault.document).toHaveBeenCalledTimes(2);
  });
});
