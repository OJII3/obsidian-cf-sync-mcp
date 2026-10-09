import {
  documentSchema,
  snapshotSchema,
  type FileRecord,
  type Snapshot,
  type VaultInfo,
} from "@cf-sync/protocol";
import { toUint8Array } from "js-base64";
import * as v from "valibot";
import * as Y from "yjs";

import type { Account } from "../durable-objects/account";
import type { Vault } from "../durable-objects/vault";
import { unwrapRpcResult } from "../rpc-result";

const MCP_DEVICE_ID = "00000000-0000-4000-8000-000000000001";

export class ReadonlyVaultApi {
  constructor(
    private readonly account: DurableObjectStub<Account>,
    private readonly vaults: DurableObjectNamespace<Vault>,
  ) {}

  async listVaults(): Promise<VaultInfo[]> {
    return unwrapRpcResult(await this.account.vaults());
  }

  async resolveVaultId(vaultId?: string): Promise<string> {
    if (vaultId) {
      unwrapRpcResult(await this.account.vault(vaultId));
      return vaultId;
    }
    const vaults = await this.listVaults();
    if (vaults.length === 1) {
      return vaults[0]!.id;
    }
    if (vaults.length === 0) {
      throw new Error("No remote Vaults are registered yet");
    }
    throw new Error("Choose a Vault by ID. Use the list_vaults tool to see available Vaults.");
  }

  async listFiles(vaultId: string): Promise<FileRecord[]> {
    await this.authorizeVault(vaultId);
    const snapshot = await this.readSnapshot(vaultId);
    return snapshot.files;
  }

  async readText(vaultId: string, fileId: string): Promise<string> {
    await this.authorizeVault(vaultId);
    const stream = unwrapRpcResult(
      await this.vaults.getByName(vaultId).document(vaultId, MCP_DEVICE_ID, fileId),
    );
    const document = v.parse(documentSchema, await new Response(stream).json());
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

  private async readSnapshot(vaultId: string): Promise<Snapshot> {
    const stream = unwrapRpcResult(
      await this.vaults.getByName(vaultId).snapshot(vaultId, MCP_DEVICE_ID),
    );
    return v.parse(snapshotSchema, await new Response(stream).json());
  }

  private async authorizeVault(vaultId: string): Promise<void> {
    unwrapRpcResult(await this.account.vault(vaultId));
    unwrapRpcResult(await this.account.registerDevice({ id: MCP_DEVICE_ID, name: "Remote MCP" }));
    unwrapRpcResult(await this.account.device(MCP_DEVICE_ID));
  }
}
