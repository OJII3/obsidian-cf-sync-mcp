import type { Device, VaultInfo } from "@cf-sync/protocol";
import { DurableObject } from "cloudflare:workers";

import { ApplicationError } from "../../domain/errors";
import { revokeDevice } from "../../usecase/revoke-device";
import { AccountRepository } from "../account-repository";
import { DurableObjectDeviceConnections } from "../device-connections";
import type { Env } from "../env";
import { rpcResult, type RpcResult } from "../rpc-result";

export class Account extends DurableObject<Env> {
  private readonly repository: AccountRepository;
  private readonly connections: DurableObjectDeviceConnections;
  private readonly oauthPrefix = "oauth:";
  private readonly storage: DurableObjectStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);

    this.storage = state.storage;
    this.repository = new AccountRepository(state.storage);
    this.connections = new DurableObjectDeviceConnections(env.VAULTS);
  }

  devices(): Promise<RpcResult<Device[]>> {
    return rpcResult(() => this.repository.devices());
  }

  registerDevice(input: { id: string; name: string }): Promise<RpcResult<Device>> {
    return rpcResult(async () => {
      const device = await this.repository.registerDevice(input);
      console.info({ event: "device.registered", deviceId: device.id });

      return device;
    });
  }

  device(id: string): Promise<RpcResult<Device>> {
    return rpcResult(async () => {
      const device = await this.repository.device(id);

      if (device.revoked) {
        throw new ApplicationError("forbidden", "Device revoked");
      }

      return device;
    });
  }

  revokeDevice(id: string): Promise<RpcResult<void>> {
    return rpcResult(async () => {
      const device = await this.repository.device(id);
      await revokeDevice(device, this.repository, this.connections);
      console.info({ event: "device.revoked", deviceId: id });
    });
  }

  vaults(): Promise<RpcResult<VaultInfo[]>> {
    return rpcResult(() => this.repository.vaults());
  }

  createVault(input: VaultInfo): Promise<RpcResult<VaultInfo>> {
    return rpcResult(async () => {
      await this.repository.saveVault(input);
      console.info({ event: "vault.created", vaultId: input.id });

      return input;
    });
  }

  vault(id: string): Promise<RpcResult<VaultInfo>> {
    return rpcResult(() => this.repository.vault(id));
  }

  oauthGet(key: string): Promise<{ value: string; expiration?: number } | null> {
    return this.storage
      .get<{ value: string; expiration?: number }>(`${this.oauthPrefix}${key}`)
      .then(async (record) => {
        if (record?.expiration !== undefined && record.expiration <= Date.now()) {
          await this.storage.delete(`${this.oauthPrefix}${key}`);
          return null;
        }
        return record ?? null;
      });
  }

  async oauthPut(key: string, record: { value: string; expiration?: number }): Promise<void> {
    await this.storage.put(`${this.oauthPrefix}${key}`, record);
  }

  async oauthDelete(key: string): Promise<void> {
    await this.storage.delete(`${this.oauthPrefix}${key}`);
  }

  async oauthList(options: {
    prefix?: string;
    startAfter?: string;
    limit: number;
  }): Promise<{ keys: { name: string }[]; cursor?: string }> {
    const prefix = `${this.oauthPrefix}${options.prefix ?? ""}`;
    const listOptions: DurableObjectListOptions = { prefix, limit: options.limit + 1 };
    if (options.startAfter) {
      listOptions.startAfter = `${this.oauthPrefix}${options.startAfter}`;
    }
    const records = await this.storage.list<{ value: string; expiration?: number }>(listOptions);
    const entries = [...records.entries()];
    const hasMore = entries.length > options.limit;
    const page = entries.slice(0, options.limit);
    const keys: { name: string }[] = [];
    for (const [storageKey, record] of page) {
      if (record.expiration !== undefined && record.expiration <= Date.now()) {
        await this.storage.delete(storageKey);
      } else {
        keys.push({ name: storageKey.slice(this.oauthPrefix.length) });
      }
    }
    const result: { keys: { name: string }[]; cursor?: string } = { keys };
    if (hasMore && page.length > 0) {
      result.cursor = page[page.length - 1]![0].slice(this.oauthPrefix.length);
    }
    return result;
  }
}
