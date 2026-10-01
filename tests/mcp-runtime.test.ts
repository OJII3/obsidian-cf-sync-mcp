import {
  digest,
  type DocumentResponse,
  type Operation,
  type OperationResult,
  type ServerMessage,
} from "@cf-sync/protocol";
import { build } from "esbuild";
import { fromUint8Array, toUint8Array } from "js-base64";
import { Miniflare, Request as RuntimeRequest, Response as RuntimeResponse } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { apply, deviceId, document, request, vaultId } from "./helpers/runtime-api";

let mf: Miniflare;
let sequence = 0;
const origin = "https://sync.test";
const importedBytes = new Uint8Array([0, 5, 255]);
let downloadRequests = 0;
async function rpc(method: string, params: unknown = {}) {
  const response = await mf.dispatchFetch(`${origin}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    result: {
      isError?: boolean;
      structuredContent: Record<string, unknown>;
      content: { text: string }[];
      tools?: {
        name: string;
        annotations: Record<string, boolean>;
        inputSchema: { properties: Record<string, { required: string[] }> };
        _meta: Record<string, unknown>;
      }[];
      protocolVersion?: string;
    };
    error?: unknown;
  };
}
async function call(name: string, args: Record<string, unknown>) {
  return (await rpc("tools/call", { name, arguments: args })).result;
}
function content(text: string) {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  const update = fromUint8Array(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return { kind: "text" as const, update };
}
function plain(value: DocumentResponse) {
  if (value.content.kind !== "text") throw new Error("not text");
  const doc = new Y.Doc();
  Y.applyUpdate(doc, toUint8Array(value.content.update));
  const text = doc.getText("content").toString();
  doc.destroy();
  return text;
}
function mutation(value: Awaited<ReturnType<typeof call>>) {
  expect(value.isError).not.toBe(true);
  return value.structuredContent as unknown as OperationResult;
}

beforeAll(async () => {
  const built = await build({
    entryPoints: ["tests/fixtures/worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers"],
  });
  mf = new Miniflare({
    modules: true,
    script: built.outputFiles[0]!.text,
    compatibilityDate: "2026-07-30",
    durableObjects: {
      VAULTS: { className: "TestVault", useSQLite: true },
      ACCOUNT: { className: "Account", useSQLite: true },
    },
    r2Buckets: ["BUCKET"],
    outboundService: async (request: RuntimeRequest) => {
      downloadRequests++;
      if (new URL(request.url).hostname !== "files.oaiusercontent.com") {
        return new RuntimeResponse(null, { status: 403 });
      }
      if (new URL(request.url).pathname === "/note") {
        return new RuntimeResponse("uploaded Markdown");
      }
      return new RuntimeResponse(importedBytes);
    },
  });
  const registered = await mf.dispatchFetch(`${origin}/register-mcp-vault`, {
    method: "POST",
    body: JSON.stringify({ id: vaultId, name: "MCP integration" }),
  });
  expect(registered.status).toBe(200);
});
afterAll(async () => {
  await mf?.dispose();
});

describe("ChatGPT MCP in Workers runtime", () => {
  it("initializes stateless transport and advertises annotated read/write tools and native file input", async () => {
    const initialized = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(initialized.result.protocolVersion).toBe("2025-06-18");
    const { result } = await rpc("tools/list");
    expect(result.tools).toHaveLength(11);
    expect(result.tools?.find((tool) => tool.name === "delete_file")?.annotations).toMatchObject({
      destructiveHint: true,
      readOnlyHint: false,
    });
    const upload = result.tools!.find((tool) => tool.name === "upload_file")!;
    expect(upload._meta["openai/fileParams"]).toEqual(["file"]);
    expect(upload.inputSchema.properties["file"]!.required).toEqual(["download_url", "file_id"]);
    expect((await mf.dispatchFetch(`${origin}/api/mcp`)).status).toBe(405);
    expect(
      (
        await mf.dispatchFetch(`${origin}/api/mcp`, {
          method: "POST",
          headers: { Origin: "https://evil.test" },
        })
      ).status,
    ).toBe(403);
  });

  it("reads device changes before R2 flush, edits through Yjs and persists to other clients and R2", async () => {
    const fileId = crypto.randomUUID();
    const created = await apply(mf, {
      type: "create",
      opId: crypto.randomUUID(),
      fileId,
      path: "mcp/bidirectional.md",
      content: content("device base"),
    });
    const bucket = await mf.getR2Bucket("BUCKET");
    expect(await bucket.get(`vaults/${vaultId}/files/mcp/bidirectional.md`)).toBeNull();
    const read = await call("read_file", { vault_id: vaultId, file_id: fileId });
    expect(read.structuredContent["text"]).toBe("device base");
    const updateArgs = {
      vault_id: vaultId,
      file_id: fileId,
      path: "mcp/bidirectional.md",
      base_revision: created.revision,
      text: "device base + ChatGPT",
      request_id: crypto.randomUUID(),
    };
    const updated = mutation(await call("update_note", updateArgs));
    expect(plain(await document(mf, fileId))).toBe("device base + ChatGPT");
    expect(mutation(await call("update_note", updateArgs))).toEqual(updated);
    const stale = await call("update_note", {
      ...updateArgs,
      text: "lost update",
      request_id: crypto.randomUUID(),
    });
    expect(stale.isError).toBe(true);
    expect(stale.content[0]!.text).toContain("File changed");
    await request(mf, "/flush");
    expect(await (await bucket.get(`vaults/${vaultId}/files/mcp/bidirectional.md`))!.text()).toBe(
      "device base + ChatGPT",
    );
    const download = await call("download_file", { vault_id: vaultId, file_id: fileId });
    const response = await mf.dispatchFetch(download.structuredContent["download_url"] as string);
    expect(await response.text()).toBe("device base + ChatGPT");
    expect(response.headers.get("Content-Disposition")).toContain("attachment;");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("preserves concurrent offline device edits with the CLI-compatible Yjs diff", async () => {
    const created = mutation(
      await call("create_note", {
        vault_id: vaultId,
        path: "mcp/concurrent.md",
        text: "base",
        request_id: crypto.randomUUID(),
      }),
    );
    const before = await document(mf, created.file!.id);
    if (before.content.kind !== "text") throw new Error();
    const offline = new Y.Doc();
    Y.applyUpdate(offline, toUint8Array(before.content.update));
    offline.getText("content").insert(0, "device ");
    mutation(
      await call("update_note", {
        vault_id: vaultId,
        file_id: created.file!.id,
        path: created.file!.path,
        base_revision: created.revision,
        text: "base ChatGPT",
        request_id: crypto.randomUUID(),
      }),
    );
    await apply(mf, {
      type: "edit",
      opId: crypto.randomUUID(),
      fileId: created.file!.id,
      path: created.file!.path,
      baseRevision: created.revision,
      content: { kind: "text", update: fromUint8Array(Y.encodeStateAsUpdate(offline)) },
    });
    offline.destroy();
    expect(plain(await document(mf, created.file!.id))).toBe("device base ChatGPT");
    expect(
      (await call("read_file", { vault_id: vaultId, file_id: created.file!.id })).structuredContent[
        "text"
      ],
    ).toBe("device base ChatGPT");
  });

  it("creates, searches, follows links, and preserves existing files on path collisions", async () => {
    const first = mutation(
      await call("create_note", {
        vault_id: vaultId,
        path: "mcp/target.md",
        text: "needle target",
        request_id: crypto.randomUUID(),
      }),
    );
    const note = mutation(
      await call("create_note", {
        vault_id: vaultId,
        path: "mcp/links.md",
        text: "[[target#Heading]]",
        request_id: crypto.randomUUID(),
      }),
    );
    const collision = mutation(
      await call("create_note", {
        vault_id: vaultId,
        path: "mcp/target.md",
        text: "new",
        request_id: crypto.randomUUID(),
      }),
    );
    expect(collision.conflict).toBe(true);
    expect(collision.file!.path).toContain("conflict");
    expect(plain(await document(mf, first.file!.id))).toBe("needle target");
    const search = await call("search", { vault_id: vaultId, query: "needle" });
    expect(search.structuredContent["results"]).toContainEqual(
      expect.objectContaining({ id: first.file!.id }),
    );
    const links = await call("list_links", { vault_id: vaultId, file_id: note.file!.id });
    expect(links.structuredContent["links"]).toEqual([
      expect.objectContaining({
        resolution: expect.objectContaining({
          status: "resolved",
          file: expect.objectContaining({ id: first.file!.id }),
        }),
      }),
    ]);
    const list = await call("list_files", { vault_id: vaultId, prefix: "mcp/", limit: 1 });
    expect(list.structuredContent["files"]).toHaveLength(1);
    expect(list.structuredContent["next_cursor"]).not.toBeNull();
  });

  it("syncs deletion and uses existing preservation for deletion races", async () => {
    const created = mutation(
      await call("create_note", {
        vault_id: vaultId,
        path: "mcp/delete.md",
        text: "safe",
        request_id: crypto.randomUUID(),
      }),
    );
    const updated = mutation(
      await call("update_note", {
        vault_id: vaultId,
        file_id: created.file!.id,
        path: created.file!.path,
        base_revision: created.revision,
        text: "new safe",
        request_id: crypto.randomUUID(),
      }),
    );
    expect(updated.revision).toBeGreaterThan(created.revision);
    const args = {
      vault_id: vaultId,
      file_id: created.file!.id,
      base_revision: created.revision,
      request_id: crypto.randomUUID(),
    };
    const removed = mutation(await call("delete_file", args));
    expect(removed.conflict).toBe(true);
    expect(plain(await document(mf, removed.file!.id))).toBe("new safe");
    expect((await request(mf, `/files/${created.file!.id}`)).status).toBe(404);
    expect(mutation(await call("delete_file", args))).toEqual(removed);
    const deleted = mutation(
      await call("delete_file", {
        ...args,
        file_id: removed.file!.id,
        base_revision: removed.revision,
        request_id: crypto.randomUUID(),
      }),
    );
    expect(deleted.conflict).toBe(false);
    expect((await request(mf, `/files/${removed.file!.id}`)).status).toBe(404);
  });

  it("keeps attachment reads/downloads on the synced blob path", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const key = crypto.randomUUID();
    expect(
      (
        await mf.dispatchFetch(`${origin}/blobs/${key}`, {
          method: "PUT",
          body: bytes,
          headers: {
            "X-Vault-Id": vaultId,
            "X-Device-Id": deviceId,
            "X-Content-Digest": await digest(bytes),
            "X-Content-Size": String(bytes.length),
          },
        })
      ).status,
    ).toBe(200);
    const op: Operation = {
      type: "create",
      opId: crypto.randomUUID(),
      fileId: crypto.randomUUID(),
      path: "mcp/binary.bin",
      content: { kind: "blob", blob: { key, size: bytes.length, digest: await digest(bytes) } },
    };
    await apply(mf, op);
    const download = await call("download_file", { vault_id: vaultId, file_id: op.fileId });
    const response = await mf.dispatchFetch(download.structuredContent["download_url"] as string);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect((await call("read_file", { vault_id: vaultId, file_id: op.fileId })).isError).toBe(true);
  });

  it("rejects unknown vaults, excluded paths and unsafe uploads without touching data", async () => {
    expect((await call("list_files", { vault_id: crypto.randomUUID() })).isError).toBe(true);
    expect(
      (
        await call("create_note", {
          vault_id: vaultId,
          path: "../secret.md",
          text: "no",
          request_id: crypto.randomUUID(),
        })
      ).isError,
    ).toBe(true);
    await request(mf, "/exclusions", { exclusions: ["excluded"] }, "PUT");
    expect(
      (
        await call("create_note", {
          vault_id: vaultId,
          path: "excluded/no.md",
          text: "no",
          request_id: crypto.randomUUID(),
        })
      ).isError,
    ).toBe(true);
    const upload = await call("upload_file", {
      vault_id: vaultId,
      path: "mcp/no.bin",
      request_id: crypto.randomUUID(),
      file: { download_url: "http://127.0.0.1/private", file_id: "file-test" },
    });
    expect(upload.isError).toBe(true);
    expect(upload.content[0]!.text).toContain("ChatGPT HTTPS");
  });
});

describe("MCP propagation and file imports", () => {
  it("notifies connected devices for create, text updates and deletion", async () => {
    const ticket = (await (await request(mf, "/tickets", {})).json()) as { ticket: string };
    const response = await mf.dispatchFetch(
      `${origin}/ws?ticket=${encodeURIComponent(ticket.ticket)}`,
      {
        headers: { "X-Vault-Id": vaultId, Upgrade: "websocket" },
      },
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const messages: ServerMessage[] = [];
    socket.addEventListener("message", (event) => {
      messages.push(JSON.parse(event.data as string) as ServerMessage);
    });
    try {
      const created = mutation(
        await call("create_note", {
          vault_id: vaultId,
          path: "mcp/notified.md",
          text: "before",
          request_id: crypto.randomUUID(),
        }),
      );
      await expect
        .poll(() =>
          messages.some(
            (message) => message.type === "changed" && message.fileId === created.file!.id,
          ),
        )
        .toBe(true);
      const updated = mutation(
        await call("update_note", {
          vault_id: vaultId,
          file_id: created.file!.id,
          path: created.file!.path,
          base_revision: created.revision,
          text: "after",
          request_id: crypto.randomUUID(),
        }),
      );
      await expect
        .poll(() =>
          messages.some(
            (message) =>
              message.type === "text" &&
              message.fileId === created.file!.id &&
              message.file.revision === updated.revision,
          ),
        )
        .toBe(true);
      messages.length = 0;
      mutation(
        await call("delete_file", {
          vault_id: vaultId,
          file_id: created.file!.id,
          base_revision: updated.revision,
          request_id: crypto.randomUUID(),
        }),
      );
      await expect
        .poll(() =>
          messages.some(
            (message) => message.type === "changed" && message.fileId === created.file!.id,
          ),
        )
        .toBe(true);
    } finally {
      socket.close();
    }
  });

  it("imports binary and Markdown from mocked ChatGPT file delivery, flushes them and deduplicates retries", async () => {
    const input = {
      vault_id: vaultId,
      path: "mcp/import.bin",
      request_id: crypto.randomUUID(),
      file: { download_url: "https://files.oaiusercontent.com/binary", file_id: "file-binary" },
    };
    const created = mutation(await call("upload_file", input));
    const beforeRetry = downloadRequests;
    expect(mutation(await call("upload_file", input))).toEqual(created);
    expect(downloadRequests).toBe(beforeRetry);
    const note = mutation(
      await call("upload_file", {
        ...input,
        path: "mcp/import.md",
        request_id: crypto.randomUUID(),
        file: { download_url: "https://files.oaiusercontent.com/note", file_id: "file-note" },
      }),
    );
    expect(plain(await document(mf, note.file!.id))).toBe("uploaded Markdown");
    const download = await call("download_file", { vault_id: vaultId, file_id: created.file!.id });
    expect(
      new Uint8Array(
        await (
          await mf.dispatchFetch(download.structuredContent["download_url"] as string)
        ).arrayBuffer(),
      ),
    ).toEqual(importedBytes);
    await request(mf, "/flush");
    const bucket = await mf.getR2Bucket("BUCKET");
    expect(
      new Uint8Array(
        await (await bucket.get(`vaults/${vaultId}/files/mcp/import.bin`))!.arrayBuffer(),
      ),
    ).toEqual(importedBytes);
    expect(await (await bucket.get(`vaults/${vaultId}/files/mcp/import.md`))!.text()).toBe(
      "uploaded Markdown",
    );
  });

  it("rejects all vault reads after the ChatGPT device is revoked", async () => {
    const response = await mf.dispatchFetch(`${origin}/revoke-mcp-device`, {
      method: "POST",
      body: JSON.stringify({ id: "dc68a69e-2a40-4b66-9fe1-664d401fa360" }),
    });
    expect(response.status).toBe(200);
    expect((await call("list_vaults", {})).isError).toBe(true);
    expect((await call("list_files", { vault_id: vaultId })).isError).toBe(true);
  });
});
