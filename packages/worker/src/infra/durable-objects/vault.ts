import {
  clientMessageSchema,
  idSchema,
  type BlobRef,
  type OperationResult,
} from "@cf-sync/protocol";
import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";

import { ApplicationError } from "../../domain/errors";
import type { VaultMeta } from "../../domain/vault-state";
import { ApplyOperation } from "../../usecase/apply-operation";
import { FlushVault } from "../../usecase/flush-vault";
import { BlobStorage } from "../blob-storage";
import type { Env } from "../env";
import { errorResponse } from "../http/responses";
import { R2VaultArchive } from "../r2-vault-archive";
import { jsonStream, readOperation } from "../rpc-json";
import { unwrapRpcResult, rpcResult, type RpcResult } from "../rpc-result";
import { VaultMaintenance } from "../vault-maintenance";
import { VaultRepository } from "../vault-repository";
import { VaultSockets } from "../vault-sockets";

export class Vault extends DurableObject<Env> {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly stateStorage: DurableObjectStorage;
  private readonly repository: VaultRepository;
  private readonly sockets: VaultSockets;
  private readonly flush: FlushVault;
  private readonly maintenance: VaultMaintenance;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);

    this.stateStorage = state.storage;
    this.repository = new VaultRepository(state.storage);
    this.sockets = new VaultSockets(state);
    this.maintenance = new VaultMaintenance(state.storage);
    this.flush = new FlushVault(
      this.repository,
      this.sockets,
      new R2VaultArchive(env.BUCKET),
      this.maintenance,
      (action) => this.serial(action),
    );
  }

  snapshot(vaultId: string, deviceId: string): Promise<RpcResult<ReadableStream<Uint8Array>>> {
    return this.execute(vaultId, deviceId, (meta) => this.readSnapshot(meta));
  }

  applyOperation(
    vaultId: string,
    deviceId: string,
    stream: ReadableStream<Uint8Array>,
  ): Promise<RpcResult<OperationResult>> {
    return rpcResult(async () => {
      const operation = await readOperation(stream);
      return unwrapRpcResult(
        await this.execute(vaultId, deviceId, async () => {
          const blobs = new BlobStorage(this.env.BUCKET, vaultId);
          const operations = new ApplyOperation(this.repository, this.sockets, blobs);

          const result = await operations.execute(operation, deviceId);
          console.info({
            event: "sync.operation.completed",
            vaultId,
            deviceId,
            operationId: operation.opId,
            operationType: operation.type,
            revision: result.revision,
            conflict: result.conflict,
          });

          return result;
        }),
      );
    });
  }

  document(
    vaultId: string,
    deviceId: string,
    fileId: string,
  ): Promise<RpcResult<ReadableStream<Uint8Array>>> {
    return this.execute(vaultId, deviceId, async () => {
      const stored = await this.repository.file(fileId);
      const content = await this.repository.content(stored);

      return jsonStream({ file: stored.file, content });
    });
  }

  setExclusions(
    vaultId: string,
    deviceId: string,
    exclusions: string[],
  ): Promise<RpcResult<ReadableStream<Uint8Array>>> {
    return this.execute(vaultId, deviceId, async (meta) => {
      await this.repository.setExclusions(meta, exclusions);
      await this.maintenance.schedule();
      this.sockets.broadcast({ type: "settings", revision: meta.revision });

      return this.readSnapshot(meta);
    });
  }

  issueTicket(
    vaultId: string,
    deviceId: string,
  ): Promise<RpcResult<{ ticket: string; expiresAt: number }>> {
    return this.execute(vaultId, deviceId, async () => {
      const ticket = await this.sockets.issueTicket(deviceId);
      await this.maintenance.schedule();

      return ticket;
    });
  }

  downloadBlob(
    vaultId: string,
    deviceId: string,
    key: string,
  ): Promise<RpcResult<ReadableStream<Uint8Array>>> {
    return rpcResult(async () => {
      unwrapRpcResult(await this.execute(vaultId, deviceId, async () => undefined));
      const blobs = new BlobStorage(this.env.BUCKET, vaultId);
      const object = await blobs.get(key);

      return object.body;
    });
  }

  uploadBlob(
    vaultId: string,
    deviceId: string,
    key: string,
    digest: string,
    body: ReadableStream<Uint8Array> | null,
    sizeHeader: string | null,
  ): Promise<RpcResult<BlobRef>> {
    return rpcResult(async () => {
      unwrapRpcResult(
        await this.execute(vaultId, deviceId, async () => this.maintenance.request("blobs")),
      );
      const blobs = new BlobStorage(this.env.BUCKET, vaultId);
      const blob = await blobs.upload(key, digest, body, sizeHeader);
      try {
        unwrapRpcResult(
          await this.execute(vaultId, deviceId, async () => this.maintenance.request("blobs")),
        );
      } catch (error) {
        const deleting = await this.stateStorage.get("deleting");
        const deleted = await this.stateStorage.get("deleted");
        if (deleting || deleted) {
          await blobs.delete(key);
        }
        throw error;
      }

      return blob;
    });
  }

  revokeDevice(deviceId: string): Promise<RpcResult<void>> {
    return this.serial(() => rpcResult(() => this.sockets.revoke(deviceId)));
  }

  deleteVault(vaultId: string): Promise<void> {
    return this.serial(async () => {
      let stage = "verify-vault";
      try {
        const meta = await this.stateStorage.get<VaultMeta>("meta");
        if (meta && meta.vaultId !== vaultId) {
          throw new ApplicationError("forbidden", "Vault mismatch");
        }
        stage = "close-connections";
        await this.stateStorage.put("deleting", true);
        this.sockets.closeAll();
        await this.stateStorage.deleteAlarm();
        stage = "delete-r2-archive";
        await this.deleteObjects(`vaults/${vaultId}/`);
        stage = "delete-r2-staging";
        await this.deleteObjects(`staging/${vaultId}/`);
        stage = "delete-durable-object-state";
        await this.stateStorage.deleteAll();
        await this.stateStorage.put("deleted", true);
      } catch (error) {
        console.error({
          event: "vault.deletion.failed",
          vaultId,
          stage,
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }
    });
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      return await this.serial(async () => {
        const path = new URL(request.url).pathname;

        if (request.method !== "GET" || path !== "/ws") {
          throw new ApplicationError("not-found", "Not found");
        }

        const vaultId = v.parse(idSchema, request.headers.get("X-Vault-Id"));
        await this.repository.initialize(vaultId);

        try {
          return await this.sockets.connect(request);
        } finally {
          await this.maintenance.schedule();
        }
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  override alarm(): Promise<void> {
    return this.flush.execute();
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    try {
      if (
        typeof data !== "string" ||
        new TextEncoder().encode(data).byteLength > 16 * 1024 * 1024
      ) {
        ws.close(1009, "Invalid message size");
        this.sockets.leave(ws);
        return;
      }
      const message = v.parse(clientMessageSchema, JSON.parse(data));
      const deviceId = await this.sockets.authenticate(ws);
      if (message.type === "presence") {
        this.sockets.presence(ws, deviceId, message);
        return;
      }
      await this.serial(async () => {
        await this.sockets.authenticate(ws);
        const meta = await this.repository.meta();
        const operations = new ApplyOperation(
          this.repository,
          this.sockets,
          new BlobStorage(this.env.BUCKET, meta.vaultId),
        );
        try {
          const result = await operations.execute(message.operation, deviceId);
          ws.send(JSON.stringify({ type: "operation-result", result }));
        } catch (error) {
          const applicationError = error instanceof ApplicationError;
          let errorMessage = "Operation persistence failed";
          if (applicationError) {
            errorMessage = error.message;
          }
          ws.send(
            JSON.stringify({
              type: "operation-error",
              opId: message.operation.opId,
              message: errorMessage,
              retryable: !applicationError,
            }),
          );
        }
      });
    } catch (error) {
      console.error(error);
      this.sockets.leave(ws);
      ws.close(1008, "Invalid or rejected sync message");
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.sockets.leave(ws);
    ws.close(code);
    console.info({ event: "websocket.closed", code });
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.sockets.leave(ws);
    ws.close(1011, "WebSocket error");
  }

  private execute<T>(
    vaultId: string,
    deviceId: string,
    action: (meta: VaultMeta) => Promise<T>,
  ): Promise<RpcResult<T>> {
    return this.serial(() =>
      rpcResult(async () => {
        const meta = await this.repository.initialize(vaultId);
        await this.sockets.assertDeviceActive(deviceId);

        return action(meta);
      }),
    );
  }

  private async readSnapshot(meta: VaultMeta): Promise<ReadableStream<Uint8Array>> {
    const stored = await this.repository.files();
    const files = stored.map((item) => item.file);

    return jsonStream({ ...meta, files });
  }

  private async deleteObjects(prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const options: R2ListOptions = { prefix, limit: 1000 };
      if (cursor) {
        options.cursor = cursor;
      }
      const page = await this.env.BUCKET.list(options);
      if (page.objects.length > 0) {
        await this.env.BUCKET.delete(page.objects.map((object) => object.key));
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action);
    this.tail = next.catch(() => undefined);

    return next;
  }
}
