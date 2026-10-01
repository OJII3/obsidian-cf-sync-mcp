import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/infra/env";
import { mcpRoutes } from "../src/infra/http/mcp-routes";
import { fetchUpload, readLimited, uploadUrl } from "../src/infra/mcp/uploads";

const url = "https://files.oaiusercontent.com/file-test?sig=temporary";
afterEach(() => vi.unstubAllGlobals());

describe("ChatGPT file imports", () => {
  it.each([
    "http://files.oaiusercontent.com/a",
    "https://127.0.0.1/a",
    "https://169.254.169.254/a",
    "https://evil.test/a",
    "https://files.oaiusercontent.com.evil.test/a",
    "https://user:secret@files.oaiusercontent.com/a",
    "https://files.oaiusercontent.com:8080/a",
  ])("rejects unsafe URL %s", (value) => {
    expect(() => uploadUrl(value)).toThrow("ChatGPT HTTPS");
  });
  it.each([
    url,
    "https://oaisdmntprwest.blob.core.windows.net/file/a",
    "https://oaisdmntprwest.s3.us-west-2.amazonaws.com/a",
  ])("accepts supported file storage %s", (value) => {
    expect(uploadUrl(value).href).toBe(value);
  });
  it("does not follow redirects and cancels an error body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(body, { status: 302, headers: { Location: "http://127.0.0.1/private" } }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(fetchUpload(url)).rejects.toThrow("attach the file again");
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: "manual" }));
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects advertised and streamed oversized bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("x", { headers: { "Content-Length": String(16 * 1024 * 1024 + 1) } }),
        ),
    );
    await expect(fetchUpload(url)).rejects.toThrow("exceeds 16 MiB");
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3));
        controller.enqueue(new Uint8Array(3));
      },
      cancel,
    });
    await expect(readLimited(stream, 5)).rejects.toThrow("byte limit");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("imports bytes through the existing blob and operation APIs and skips expired URL fetches on committed retries", async () => {
    const vaultId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const bytes = new Uint8Array([0, 5, 255]);
    const result = {
      opId: requestId,
      revision: 1,
      previousRevision: null,
      previousPathRevision: null,
      file: null,
      conflict: false,
    };
    const account = {
      vault: vi.fn(async () => ({ ok: true, value: { id: vaultId, name: "Vault" } })),
      registerDevice: vi.fn(async () => ({ ok: true, value: {} })),
    };
    const vault = {
      operationResult: vi.fn(async () => ({ ok: true, value: null as typeof result | null })),
      uploadBlob: vi.fn(
        async (
          _vault: string,
          _device: string,
          key: string,
          digest: string,
          body: ReadableStream<Uint8Array>,
          size: string,
        ) => {
          expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(bytes);
          return { ok: true, value: { key, digest, size: Number(size) } };
        },
      ),
      applyOperation: vi.fn(
        async (_vault: string, _device: string, body: ReadableStream<Uint8Array>) => {
          expect(await new Response(body).json()).toMatchObject({
            type: "create",
            opId: requestId,
            fileId: requestId,
            path: "a.bin",
            content: { kind: "blob" },
          });
          return { ok: true, value: result };
        },
      ),
    };
    const env = {
      ACCOUNT: { getByName: () => account },
      VAULTS: { getByName: () => vault },
    } as unknown as Env;
    const app = new Hono<{ Bindings: Env }>().route("/api", mcpRoutes);
    const fetch = vi.fn().mockImplementation(async () => new Response(bytes));
    vi.stubGlobal("fetch", fetch);
    const call = async () => {
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
            params: {
              name: "upload_file",
              arguments: {
                vault_id: vaultId,
                path: "a.bin",
                request_id: requestId,
                file: { download_url: url, file_id: "file-test" },
              },
            },
          }),
        },
        env,
      );
      return (await response.json()) as {
        result: { isError?: boolean; structuredContent: unknown };
      };
    };
    expect((await call()).result.structuredContent).toEqual(result);
    expect(vault.uploadBlob).toHaveBeenCalledOnce();
    expect(vault.applyOperation).toHaveBeenCalledOnce();
    vault.operationResult.mockResolvedValue({ ok: true, value: result });
    fetch.mockRejectedValue(new Error("Expired URL"));
    expect((await call()).result.structuredContent).toEqual(result);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
