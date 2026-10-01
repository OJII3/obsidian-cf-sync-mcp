import { idSchema, pathSchema, type OperationResult, type Operation } from "@cf-sync/protocol";
import { fromUint8Array, toUint8Array } from "js-base64";
import { simpleDiffString } from "lib0/diff";
import * as v from "valibot";
import * as Y from "yjs";

import { ApplicationError } from "../domain/errors";
import type { StoredFile } from "../domain/vault-state";

import { ApplyOperation } from "./apply-operation";
import type { VaultStore, VaultNotifications, BlobVerifier } from "./ports";

export const writeTextSchema = v.object({
  opId: idSchema,
  path: pathSchema,
  text: v.pipe(v.string(), v.maxBytes(1024 * 1024)),
  fileId: v.optional(idSchema),
  baseRevision: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
});

/** Run inside the Vault's serial queue, including the CRDT read and operation commit. */
export class WriteText {
  constructor(
    private readonly repository: VaultStore,
    private readonly sockets: VaultNotifications,
    private readonly blobs: BlobVerifier,
  ) {}

  async execute(
    input: v.InferOutput<typeof writeTextSchema>,
    deviceId: string,
  ): Promise<OperationResult> {
    const previous = await this.repository.operationResult(input.opId);
    if (previous) {
      return previous;
    }
    const current = await this.current(input);
    const content = await this.content(input.text, current);
    let operation: Operation = {
      type: "create",
      opId: input.opId,
      fileId: input.opId,
      path: input.path,
      content,
    };
    if (current) {
      operation = {
        type: "edit",
        opId: input.opId,
        fileId: current.file.id,
        path: current.file.path,
        baseRevision: current.file.revision,
        content,
      };
    }
    return new ApplyOperation(this.repository, this.sockets, this.blobs).execute(
      operation,
      deviceId,
    );
  }

  private async current(
    input: v.InferOutput<typeof writeTextSchema>,
  ): Promise<StoredFile | undefined> {
    if (!input.path.toLowerCase().endsWith(".md")) {
      throw new ApplicationError(
        "invalid-input",
        "Text writes require a Markdown (.md) path; use upload_file for attachments",
      );
    }
    const files = await this.repository.files();
    const current = files.find(({ file }) => file.id === input.fileId);
    if (input.fileId && !current) {
      throw new ApplicationError("not-found", "File not found; read again before editing");
    }
    if (!input.fileId && input.baseRevision !== undefined) {
      throw new ApplicationError("invalid-input", "baseRevision is only valid when editing a file");
    }
    if (
      current &&
      (current.file.revision !== input.baseRevision || current.file.path !== input.path)
    ) {
      throw new ApplicationError(
        "conflict",
        "File changed; read it again before replacing its text",
      );
    }
    return current;
  }

  private async content(value: string, current: StoredFile | undefined) {
    const doc = new Y.Doc();
    try {
      if (current) {
        const content = await this.repository.content(current);
        if (content.kind !== "text") {
          throw new ApplicationError("invalid-input", "File is not a text document");
        }
        Y.applyUpdate(doc, toUint8Array(content.update));
      }
      // The same prefix/suffix-preserving edit used by the standalone CLI.
      const change = simpleDiffString(doc.getText("content").toString(), value);
      doc.transact(() => {
        const text = doc.getText("content");
        text.delete(change.index, change.remove);
        text.insert(change.index, change.insert);
      });
      return { kind: "text" as const, update: fromUint8Array(Y.encodeStateAsUpdate(doc)) };
    } finally {
      doc.destroy();
    }
  }
}
