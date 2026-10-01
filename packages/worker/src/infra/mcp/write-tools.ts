import { digest } from "@cf-sync/protocol";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ApplicationError } from "../../domain/errors";
import { jsonStream } from "../rpc-json";
import { unwrapRpcResult } from "../rpc-result";

import { uuid, path, integer, fileTarget, write, mutation, oauthMeta } from "./schemas";
import { safe } from "./tool-result";
import { fetchUpload } from "./uploads";
import type { McpVaultClient } from "./vault-client";

export function registerWriteTools(server: McpServer, client: McpVaultClient): void {
  registerCreateNote(server, client);
  registerUpdateNote(server, client);
  registerDeleteFile(server, client);
  registerUploadFile(server, client);
}

const create_note = {
  description:
    "Create a Markdown note and sync it to devices. Existing-path collisions are preserved under a conflict filename; report the returned path. request_id is a new UUID, reused only for retries of this exact write.",
  inputSchema: { vault_id: uuid, path, text: z.string().max(1024 * 1024), request_id: uuid },
  outputSchema: mutation,
  annotations: { ...write, destructiveHint: false },
  _meta: oauthMeta,
};

function registerCreateNote(server: McpServer, client: McpVaultClient): void {
  server.registerTool("create_note", create_note, (input) =>
    safe(async () => {
      const vault = await client.vault(input.vault_id);
      return unwrapRpcResult(
        await vault.writeText(
          input.vault_id,
          client.deviceId,
          jsonStream({ opId: input.request_id, path: input.path, text: input.text }),
        ),
      );
    }),
  );
}

const update_note = {
  description:
    "Replace Markdown text using the existing Yjs diff/sync pipeline. Requires file_id, path and base_revision from a current read. A stale read must be refreshed before retrying. request_id is a UUID for this exact mutation.",
  inputSchema: {
    ...fileTarget,
    path,
    base_revision: integer,
    text: z.string().max(1024 * 1024),
    request_id: uuid,
  },
  outputSchema: mutation,
  annotations: write,
  _meta: oauthMeta,
};

function registerUpdateNote(server: McpServer, client: McpVaultClient): void {
  server.registerTool("update_note", update_note, (input) =>
    safe(async () => {
      const vault = await client.vault(input.vault_id);
      return unwrapRpcResult(
        await vault.writeText(
          input.vault_id,
          client.deviceId,
          jsonStream({
            opId: input.request_id,
            fileId: input.file_id,
            path: input.path,
            baseRevision: input.base_revision,
            text: input.text,
          }),
        ),
      );
    }),
  );
}

const delete_file = {
  description:
    "Delete a synced file on all devices. Read first, then provide its base_revision. Existing sync handling preserves concurrent edits as a conflict file; report that result. request_id is a UUID for this deletion.",
  inputSchema: { ...fileTarget, base_revision: integer, request_id: uuid },
  outputSchema: mutation,
  annotations: write,
  _meta: oauthMeta,
};

function registerDeleteFile(server: McpServer, client: McpVaultClient): void {
  server.registerTool("delete_file", delete_file, (input) =>
    safe(async () =>
      client.apply(input.vault_id, {
        type: "delete",
        opId: input.request_id,
        fileId: input.file_id,
        baseRevision: input.base_revision,
      }),
    ),
  );
}

const upload_file = {
  description:
    "Import a file explicitly attached in ChatGPT (up to 16 MiB; Markdown up to 1 MiB) into a vault and sync to devices. Provide an explicit vault path. For replacement include file_id and base_revision from a read/list. Reuse request_id only for retrying this exact import. Only ChatGPT file download hosts are fetched.",
  inputSchema: {
    vault_id: uuid,
    path,
    request_id: uuid,
    file_id: uuid.optional(),
    base_revision: integer.optional(),
    file: z.object({
      download_url: z.string().url(),
      file_id: z.string().min(1),
      mime_type: z.string().optional(),
      file_name: z.string().optional(),
    }),
  },
  outputSchema: mutation,
  annotations: { ...write, openWorldHint: true },
  _meta: { ...oauthMeta, "openai/fileParams": ["file"] },
};

type UploadInput = z.infer<z.ZodObject<typeof upload_file.inputSchema>>;

function registerUploadFile(server: McpServer, client: McpVaultClient): void {
  server.registerTool("upload_file", upload_file, (input) => safe(() => importFile(client, input)));
}

async function importFile(client: McpVaultClient, input: UploadInput) {
  if (!!input.file_id !== (input.base_revision !== undefined)) {
    throw new ApplicationError(
      "invalid-input",
      "Replacement requires both file_id and base_revision",
    );
  }
  const vault = await client.vault(input.vault_id);
  const previous = unwrapRpcResult(
    await vault.operationResult(input.vault_id, client.deviceId, input.request_id),
  );
  if (previous) {
    return previous;
  }
  const bytes = await fetchUpload(input.file.download_url);
  if (input.path.toLowerCase().endsWith(".md")) {
    const text = decodeMarkdown(bytes);
    return unwrapRpcResult(
      await vault.writeText(
        input.vault_id,
        client.deviceId,
        jsonStream({
          opId: input.request_id,
          fileId: input.file_id,
          path: input.path,
          baseRevision: input.base_revision,
          text,
        }),
      ),
    );
  }
  const blob = unwrapRpcResult(
    await vault.uploadBlob(
      input.vault_id,
      client.deviceId,
      input.request_id,
      await digest(bytes),
      new Response(bytes.slice().buffer).body!,
      String(bytes.length),
    ),
  );
  if (input.file_id) {
    return client.apply(input.vault_id, {
      type: "edit",
      opId: input.request_id,
      fileId: input.file_id,
      path: input.path,
      baseRevision: input.base_revision!,
      content: { kind: "blob", blob },
    });
  }
  return client.apply(input.vault_id, {
    type: "create",
    opId: input.request_id,
    fileId: input.request_id,
    path: input.path,
    content: { kind: "blob", blob },
  });
}

function decodeMarkdown(bytes: Uint8Array): string {
  if (bytes.length > 1024 * 1024) {
    throw new ApplicationError("invalid-input", "Markdown exceeds 1 MiB");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ApplicationError("invalid-input", "Markdown must be valid UTF-8");
  }
}
