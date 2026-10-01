import type { FileRecord, Snapshot } from "@cf-sync/protocol";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ApplicationError } from "../../domain/errors";
import { extractLinks, resolveLink, type LinkResolution } from "../../service/obsidian-links";
import { unwrapRpcResult } from "../rpc-result";

import { uuid, integer, fileTarget, page, read, fileRecord, oauthMeta } from "./schemas";
import { safe } from "./tool-result";
import type { McpVaultClient } from "./vault-client";

export function registerReadTools(server: McpServer, client: McpVaultClient): void {
  registerListVaults(server, client);
  registerListFiles(server, client);
  registerSearch(server, client);
  registerReadFile(server, client);
  registerListLinks(server, client);
  registerResolveLink(server, client);
  registerDownloadFile(server, client);
}

const list_vaults = {
  description: "List the owner's remote Obsidian vaults.",
  inputSchema: {},
  outputSchema: { vaults: z.array(z.object({ id: uuid, name: z.string() })) },
  annotations: read,
  _meta: oauthMeta,
};

function registerListVaults(server: McpServer, client: McpVaultClient): void {
  server.registerTool("list_vaults", list_vaults, () =>
    safe(async () => {
      await client.registerDevice();
      return { vaults: unwrapRpcResult(await client.env.ACCOUNT.getByName("owner").vaults()) };
    }),
  );
}

const list_files = {
  description:
    "List current synced files, excluding vault exclusions. Cursor is the last path returned; pagination is live, not a frozen snapshot.",
  inputSchema: { vault_id: uuid, prefix: z.string().max(1024).default(""), ...page },
  outputSchema: {
    files: z.array(fileRecord),
    revision: integer,
    next_cursor: z.string().nullable(),
  },
  annotations: read,
  _meta: oauthMeta,
};

function registerListFiles(server: McpServer, client: McpVaultClient): void {
  server.registerTool("list_files", list_files, (input) =>
    safe(async () => {
      const snapshot = await client.snapshot(input.vault_id);
      const files = snapshot.files
        .filter(
          (file) =>
            file.path.startsWith(input.prefix) && (!input.cursor || file.path > input.cursor),
        )
        .sort(comparePaths);
      const selected = files.slice(0, input.limit);
      return {
        files: selected,
        revision: snapshot.revision,
        next_cursor: nextCursor(files, selected.length),
      };
    }),
  );
}

const search = {
  description:
    "Search file paths and Markdown text using a case-insensitive literal phrase. Scans at most 100 files / 2 MiB per page. Continue next_cursor for remaining files; skipped large files are reported. No attachment OCR or semantic index.",
  inputSchema: {
    vault_id: uuid,
    query: z.string().min(1).max(200),
    cursor: z.string().max(1024).optional(),
  },
  outputSchema: {
    results: z.array(
      z.object({
        id: uuid,
        title: z.string(),
        url: z.string(),
        snippet: z.string(),
        revision: integer,
      }),
    ),
    next_cursor: z.string().nullable(),
    skipped: z.array(z.string()),
    revision: integer,
  },
  annotations: read,
  _meta: oauthMeta,
};

function registerSearch(server: McpServer, client: McpVaultClient): void {
  server.registerTool("search", search, (input) =>
    safe(async () => {
      const snapshot = await client.snapshot(input.vault_id);
      const files = snapshot.files
        .filter((file) => !input.cursor || file.path > input.cursor)
        .sort(comparePaths);
      const query = input.query.toLowerCase();
      const results = [];
      const skipped = [];
      let scanned = 0;
      let bytes = 0;
      for (const file of files) {
        if (scanned >= 100 || bytes >= 2 * 1024 * 1024) {
          break;
        }
        if (
          file.kind === "text" &&
          file.size <= 1024 * 1024 &&
          bytes + file.size > 2 * 1024 * 1024
        ) {
          break;
        }
        scanned++;
        const document = await searchDocument(
          client,
          input.vault_id,
          file,
          snapshot,
          2 * 1024 * 1024 - bytes,
        );
        if (!document) {
          skipped.push(file.path);
          continue;
        }
        if (document.skipped) {
          skipped.push(file.path);
        }
        const { text, file: currentFile } = document;
        bytes += document.scannedBytes;
        const offset = text.toLowerCase().indexOf(query);
        if (file.path.toLowerCase().includes(query) || offset >= 0) {
          results.push({
            id: file.id,
            title: file.path,
            url: client.downloadUrl(input.vault_id, file),
            snippet: text.slice(Math.max(0, offset - 100), Math.max(0, offset - 100) + 300),
            revision: currentFile.revision,
          });
        }
      }
      return {
        results,
        skipped,
        revision: snapshot.revision,
        next_cursor: nextCursor(files, scanned),
      };
    }),
  );
}

const read_file = {
  description:
    "Read current Markdown text directly from sync state, including edits not yet flushed to R2. Save its file revision before editing. Paginate long notes with offset.",
  inputSchema: {
    ...fileTarget,
    offset: integer.default(0),
    length: integer.min(1).max(64000).default(32000),
  },
  outputSchema: {
    file: fileRecord,
    text: z.string(),
    total_length: integer,
    next_offset: integer.nullable(),
  },
  annotations: read,
  _meta: oauthMeta,
};

function registerReadFile(server: McpServer, client: McpVaultClient): void {
  server.registerTool("read_file", read_file, (input) =>
    safe(async () => {
      const document = await client.text(input.vault_id, input.file_id);
      const end = Math.min(document.text.length, input.offset + input.length);
      return {
        file: document.file,
        text: document.text.slice(input.offset, end),
        total_length: document.text.length,
        next_offset: nextOffset(end, document.text.length),
      };
    }),
  );
}

const list_links = {
  description:
    "Extract Obsidian wikilinks, embeds and inline Markdown links in a note; report resolved targets, ambiguity, fragments and external links. Never fetches external URLs. Limited to the first 128,000 characters and 200 links; reports truncation.",
  inputSchema: fileTarget,
  outputSchema: { file: fileRecord, links: z.array(z.unknown()), truncated: z.boolean() },
  annotations: read,
  _meta: oauthMeta,
};

function registerListLinks(server: McpServer, client: McpVaultClient): void {
  server.registerTool("list_links", list_links, (input) =>
    safe(async () => {
      const document = await client.text(input.vault_id, input.file_id);
      const snapshot = await client.snapshot(input.vault_id);
      const links = extractLinks(document.text.slice(0, 128000), 201);
      return {
        file: document.file,
        links: links.slice(0, 200).map((link) => ({
          ...link,
          resolution: limitCandidates(resolveLink(link, document.file.path, snapshot.files)),
        })),
        truncated: document.text.length > 128000 || links.length > 200,
      };
    }),
  );
}

const resolve_link = {
  description:
    "Follow a vault link from a source note. Returns matching file metadata and heading/block fragment; ambiguous links return candidates, never a guessed file. Use read_file for target contents. Does not verify fragment existence or fetch websites.",
  inputSchema: { ...fileTarget, link: z.string().min(1).max(2048) },
  outputSchema: { resolution: z.unknown() },
  annotations: read,
  _meta: oauthMeta,
};

function registerResolveLink(server: McpServer, client: McpVaultClient): void {
  server.registerTool("resolve_link", resolve_link, (input) =>
    safe(async () => {
      const document = await client.document(input.vault_id, input.file_id);
      const snapshot = await client.snapshot(input.vault_id);
      return {
        resolution: limitCandidates(resolveLink(input.link, document.file.path, snapshot.files)),
      };
    }),
  );
}

const download_file = {
  description:
    "Get a private download link for a current vault file. The owner opens it in a browser and signs in with Cloudflare Access. The URL is not a public download or a guaranteed ChatGPT-native attachment.",
  inputSchema: fileTarget,
  outputSchema: { file: fileRecord, download_url: z.string(), authentication: z.string() },
  annotations: read,
  _meta: oauthMeta,
};

function registerDownloadFile(server: McpServer, client: McpVaultClient): void {
  server.registerTool("download_file", download_file, (input) =>
    safe(async () => {
      const document = await client.document(input.vault_id, input.file_id);
      return {
        file: document.file,
        download_url: client.downloadUrl(input.vault_id, document.file),
        authentication: "Cloudflare Access browser login required",
      };
    }),
  );
}

function comparePaths(a: { path: string }, b: { path: string }): number {
  if (a.path < b.path) {
    return -1;
  }
  if (a.path > b.path) {
    return 1;
  }
  return 0;
}

function nextCursor(files: { path: string }[], count: number): string | null {
  if (count > 0 && count < files.length) {
    return files[count - 1]!.path;
  }
  return null;
}

function nextOffset(offset: number, length: number): number | null {
  if (offset < length) {
    return offset;
  }
  return null;
}

async function searchDocument(
  client: McpVaultClient,
  vaultId: string,
  file: FileRecord,
  snapshot: Snapshot,
  budget: number,
) {
  if (file.kind !== "text") {
    return { file, text: "", scannedBytes: 0, skipped: false };
  }
  if (file.size > 1024 * 1024) {
    return { file, text: "", scannedBytes: 0, skipped: true };
  }
  try {
    const document = await client.text(vaultId, file.id, Math.min(1024 * 1024, budget), snapshot);
    return { ...document, scannedBytes: document.file.size, skipped: false };
  } catch (error) {
    if (
      error instanceof ApplicationError &&
      (error.kind === "not-found" || error.kind === "invalid-input")
    ) {
      return null;
    }
    throw error;
  }
}

function limitCandidates(resolution: LinkResolution) {
  if (resolution.status !== "ambiguous") {
    return resolution;
  }
  return {
    ...resolution,
    candidates: resolution.candidates.slice(0, 10),
    candidate_count: resolution.candidates.length,
    candidates_truncated: resolution.candidates.length > 10,
  };
}
