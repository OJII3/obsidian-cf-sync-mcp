import {
  documentSchema,
  snapshotSchema,
  isExcluded,
  idSchema,
  type FileRecord,
  type Operation,
  type Snapshot,
} from "@cf-sync/protocol";
import * as v from "valibot";

import { ApplicationError } from "../../domain/errors";
import { materializeText } from "../../service/text-content";
import type { Env } from "../env";
import { jsonStream } from "../rpc-json";
import { unwrapRpcResult } from "../rpc-result";

export const DEFAULT_MCP_DEVICE_ID = "dc68a69e-2a40-4b66-9fe1-664d401fa360";

export class McpVaultClient {
  readonly deviceId: string;
  private registration?: Promise<void>;
  constructor(
    readonly env: Env,
    readonly origin: string,
  ) {
    this.deviceId = v.parse(idSchema, env.MCP_DEVICE_ID ?? DEFAULT_MCP_DEVICE_ID);
  }

  registerDevice(): Promise<void> {
    this.registration ??= (async () => {
      unwrapRpcResult(
        await this.env.ACCOUNT.getByName("owner").registerDevice({
          id: this.deviceId,
          name: "ChatGPT",
        }),
      );
    })();
    return this.registration;
  }

  async vault(vaultId: string) {
    v.parse(idSchema, vaultId);
    const account = this.env.ACCOUNT.getByName("owner");
    unwrapRpcResult(await account.vault(vaultId));
    // Registration is idempotent and refuses to re-enable a revoked device.
    await this.registerDevice();
    return this.env.VAULTS.getByName(vaultId);
  }

  async snapshot(vaultId: string) {
    const vault = await this.vault(vaultId);
    const stream = unwrapRpcResult(await vault.snapshot(vaultId, this.deviceId));
    const snapshot = v.parse(snapshotSchema, await new Response(stream).json());
    return {
      ...snapshot,
      files: snapshot.files.filter((file) => !isExcluded(file.path, snapshot.exclusions)),
    };
  }

  async document(vaultId: string, fileId: string, knownSnapshot?: Snapshot) {
    v.parse(idSchema, fileId);
    const snapshot = knownSnapshot ?? (await this.snapshot(vaultId));
    if (!snapshot.files.some((file) => file.id === fileId)) {
      throw new ApplicationError("not-found", "File not found or excluded");
    }
    const vault = this.env.VAULTS.getByName(vaultId);
    const stream = unwrapRpcResult(await vault.document(vaultId, this.deviceId, fileId));
    return v.parse(documentSchema, await new Response(stream).json());
  }

  async text(vaultId: string, fileId: string, maximumBytes?: number, snapshot?: Snapshot) {
    const document = await this.document(vaultId, fileId, snapshot);
    if (maximumBytes !== undefined && document.file.size > maximumBytes) {
      throw new ApplicationError("invalid-input", "Text file exceeds scan limit");
    }
    if (document.content.kind !== "text") {
      throw new ApplicationError("invalid-input", "File is an attachment; use download_file");
    }
    return {
      file: document.file,
      text: new TextDecoder().decode(materializeText(document.content.update)),
    };
  }

  async apply(vaultId: string, operation: Operation) {
    const vault = await this.vault(vaultId);
    return unwrapRpcResult(
      await vault.applyOperation(vaultId, this.deviceId, jsonStream(operation)),
    );
  }

  downloadUrl(vaultId: string, file: FileRecord) {
    return new URL(`/api/mcp/files/${vaultId}/${file.id}`, this.origin).href;
  }
}
