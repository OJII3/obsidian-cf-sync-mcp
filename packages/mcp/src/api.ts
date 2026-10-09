import { documentSchema, snapshotSchema, type FileRecord, type Snapshot } from "@cf-sync/protocol";
import { toUint8Array } from "js-base64";
import * as v from "valibot";
import * as Y from "yjs";

import type { McpConfig } from "./config";

export class ReadonlyVaultApi {
  constructor(private readonly config: McpConfig) {}

  async listFiles(): Promise<FileRecord[]> {
    const response = await this.get(
      `/api/vaults/${encodeURIComponent(this.config.binding.vaultId)}/snapshot`,
    );
    const snapshot = v.parse(snapshotSchema, await response.json()) satisfies Snapshot;

    return snapshot.files;
  }

  async readText(fileId: string): Promise<string> {
    const response = await this.get(
      `/api/vaults/${encodeURIComponent(this.config.binding.vaultId)}/files/${encodeURIComponent(fileId)}`,
    );
    const document = v.parse(documentSchema, await response.json());

    if (document.content.kind !== "text") {
      throw new Error("The requested file is an attachment, not a text note");
    }

    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, toUint8Array(document.content.update));
      return doc.getText("content").toString();
    } finally {
      doc.destroy();
    }
  }

  private async get(path: string): Promise<Response> {
    const response = await fetch(new URL(path, this.config.binding.serverUrl), {
      headers: {
        "CF-Access-Client-Id": this.config.credentials.clientId,
        "CF-Access-Client-Secret": this.config.credentials.clientSecret,
        "X-Device-Id": this.config.binding.deviceId,
      },
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new Error(`CF Sync API request failed: HTTP ${response.status}`);
    }

    return response;
  }
}
