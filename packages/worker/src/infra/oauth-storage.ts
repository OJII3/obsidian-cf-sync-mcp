import type { Account } from "./durable-objects/account";

export class OAuthStorage {
  constructor(private readonly account: DurableObjectStub<Account>) {}

  async get(key: string | string[], options?: { type?: string }): Promise<unknown> {
    if (Array.isArray(key)) {
      const values = await Promise.all(key.map((item) => this.get(item, options)));
      return new Map(key.map((item, index) => [item, values[index]]));
    }
    const record = await this.account.oauthGet(key);
    if (!record) {
      return null;
    }
    if (options?.type === "json") {
      return JSON.parse(record.value) as unknown;
    }
    if (options?.type === "arrayBuffer") {
      return new TextEncoder().encode(record.value).buffer;
    }
    if (options?.type === "stream") {
      return new Response(record.value).body;
    }
    return record.value;
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { expiration?: number; expirationTtl?: number },
  ): Promise<void> {
    let text: string;
    if (typeof value === "string") {
      text = value;
    } else if (value instanceof ArrayBuffer) {
      text = new TextDecoder().decode(value);
    } else if (ArrayBuffer.isView(value)) {
      text = new TextDecoder().decode(value);
    } else {
      text = await new Response(value).text();
    }
    let expiration: number | undefined;
    if (options?.expiration !== undefined) {
      expiration = options.expiration * 1000;
    } else if (options?.expirationTtl !== undefined) {
      expiration = Date.now() + options.expirationTtl * 1000;
    }
    const record: { value: string; expiration?: number } = { value: text };
    if (expiration !== undefined) {
      record.expiration = expiration;
    }
    await this.account.oauthPut(key, record);
  }

  delete(key: string): Promise<void> {
    return this.account.oauthDelete(key);
  }

  async list(options?: {
    prefix?: string | null;
    limit?: number;
    cursor?: string | null;
  }): Promise<{
    list_complete: boolean;
    cursor?: string;
    keys: { name: string; expiration?: number; metadata: null }[];
    cacheStatus: null;
  }> {
    const listOptions: { prefix?: string; startAfter?: string; limit: number } = {
      limit: options?.limit ?? 1000,
    };
    if (options?.prefix) {
      listOptions.prefix = options.prefix;
    }
    if (options?.cursor) {
      listOptions.startAfter = options.cursor;
    }
    const page = await this.account.oauthList(listOptions);
    const result: {
      list_complete: boolean;
      cursor?: string;
      keys: { name: string; expiration?: number; metadata: null }[];
      cacheStatus: null;
    } = {
      list_complete: page.cursor === undefined,
      keys: page.keys.map(({ name }) => ({ name, metadata: null })),
      cacheStatus: null,
    };
    if (page.cursor) {
      result.cursor = page.cursor;
    }
    return result;
  }
}
