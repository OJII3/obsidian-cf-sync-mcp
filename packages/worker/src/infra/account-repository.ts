import type { Device, VaultInfo } from "@cf-sync/protocol";

import { ApplicationError } from "../domain/errors";

export class AccountRepository {
  constructor(private readonly storage: DurableObjectStorage) {}

  registerDevice(input: { id: string; name: string }): Promise<Device> {
    return this.storage.transaction(async (tx) => {
      const previous = await tx.get<Device>(`device:${input.id}`);

      if (previous?.revoked) {
        throw new ApplicationError("forbidden", "Device revoked");
      }

      const device: Device = { ...input, revoked: false };
      await tx.put(`device:${input.id}`, device);

      return device;
    });
  }

  async devices(): Promise<Device[]> {
    const devices = await this.storage.list<Device>({ prefix: "device:" });

    return [...devices.values()];
  }

  async device(id: string): Promise<Device> {
    const device = await this.storage.get<Device>(`device:${id}`);

    if (!device) {
      throw new ApplicationError("not-found", "Unknown device");
    }

    return device;
  }

  async revoke(device: Device): Promise<void> {
    await this.storage.put(`device:${device.id}`, { ...device, revoked: true });
  }

  async vaults(): Promise<VaultInfo[]> {
    const vaults = await this.storage.list<VaultInfo>({ prefix: "vault:" });
    const deleting = await this.storage.list<boolean>({ prefix: "vault-deleting:" });

    return [...vaults.values()].filter((vault) => !deleting.has(`vault-deleting:${vault.id}`));
  }

  async vault(id: string): Promise<VaultInfo> {
    if (await this.storage.get(`vault-deleting:${id}`)) {
      throw new ApplicationError("not-found", "Unknown vault");
    }

    const vault = await this.storage.get<VaultInfo>(`vault:${id}`);

    if (!vault) {
      throw new ApplicationError("not-found", "Unknown vault");
    }

    return vault;
  }

  async saveVault(vault: VaultInfo): Promise<void> {
    await this.storage.transaction(async (tx) => {
      const deleting = await tx.get(`vault-deleting:${vault.id}`);
      const deleted = await tx.get(`vault-deleted:${vault.id}`);
      const existing = await tx.get(`vault:${vault.id}`);
      if (deleting || deleted) {
        throw new ApplicationError("conflict", "Vault ID already used");
      }
      if (existing) {
        if (existing.name === vault.name) {
          return;
        }
        throw new ApplicationError("conflict", "Vault ID already used");
      }
      await tx.put(`vault:${vault.id}`, vault);
    });
  }

  async beginVaultDeletion(id: string): Promise<void> {
    await this.storage.transaction(async (tx) => {
      const existing = await tx.get<VaultInfo>(`vault:${id}`);
      const deleting = await tx.get(`vault-deleting:${id}`);
      if (!existing && !deleting) {
        throw new ApplicationError("not-found", "Unknown vault");
      }
      await tx.put(`vault-deleting:${id}`, true);
    });
  }

  async finishVaultDeletion(id: string): Promise<void> {
    await this.storage.transaction(async (tx) => {
      await tx.delete([`vault:${id}`, `vault-deleting:${id}`]);
      await tx.put(`vault-deleted:${id}`, true);
    });
  }
}
