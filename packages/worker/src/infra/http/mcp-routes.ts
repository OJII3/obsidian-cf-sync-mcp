import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";

import { materializeText } from "../../service/text-content";
import type { Env } from "../env";
import { createMcpServer } from "../mcp/server";
import { McpVaultClient } from "../mcp/vault-client";
import { unwrapRpcResult } from "../rpc-result";

/** Mounted inside apiRoutes, after its existing Access JWT middleware. */
export const mcpRoutes = new Hono<{ Bindings: Env }>();

mcpRoutes.all("/mcp", async (c) => {
  const origin = new URL(c.req.url).origin;
  const requestOrigin = c.req.header("Origin");
  if (requestOrigin && requestOrigin !== origin && requestOrigin !== "https://chatgpt.com") {
    return c.json({ error: "Origin not allowed" }, 403);
  }
  c.header("Cache-Control", "no-store");
  if (c.req.method !== "POST") {
    c.header("Allow", "POST");
    return c.json({ error: "Stateless MCP accepts POST requests" }, 405);
  }
  const server = createMcpServer(c.env, origin);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: 2 * 1024 * 1024,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(c.req.raw);
    // JSON responses are complete when handleRequest resolves; no long-lived sessions or sockets.
    response.headers.set("Cache-Control", "no-store");
    return response;
  } finally {
    await server.close();
  }
});

mcpRoutes.get("/mcp/files/:vaultId/:fileId", async (c) => {
  const client = new McpVaultClient(c.env, new URL(c.req.url).origin);
  const vaultId = c.req.param("vaultId");
  const document = await client.document(vaultId, c.req.param("fileId"));
  let body: ReadableStream<Uint8Array>;
  if (document.content.kind === "text") {
    body = new Response(materializeText(document.content.update).slice().buffer).body!;
  } else {
    const vault = await client.vault(vaultId);
    body = unwrapRpcResult(
      await vault.downloadBlob(vaultId, client.deviceId, document.content.blob.key),
    );
  }
  const filename = document.file.path.split("/").at(-1)!;
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return new Response(body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encoded}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
