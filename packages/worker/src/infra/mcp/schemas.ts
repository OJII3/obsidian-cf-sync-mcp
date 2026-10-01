import { idSchema, pathSchema } from "@cf-sync/protocol";
import * as v from "valibot";
import { z } from "zod";

export const uuid = z
  .string()
  .refine((value) => v.safeParse(idSchema, value).success, "Expected UUID");
export const path = z
  .string()
  .refine((value) => v.safeParse(pathSchema, value).success, "Unsupported vault path");
export const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const fileTarget = { vault_id: uuid, file_id: uuid };
export const page = {
  cursor: z.string().max(1024).optional(),
  limit: integer.min(1).max(100).default(50),
};
export const read = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
export const write = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};
export const fileRecord = z.object({
  id: uuid,
  path: z.string(),
  kind: z.enum(["text", "blob"]),
  revision: integer,
  pathRevision: integer,
  digest: z.string(),
  size: integer,
  conflict: z.boolean(),
});
export const mutation = z.object({
  opId: uuid,
  revision: integer,
  previousRevision: integer.nullable(),
  previousPathRevision: integer.nullable(),
  file: fileRecord.nullable(),
  conflict: z.boolean(),
  conflictReason: z.string().optional(),
});
export const oauthMeta = { securitySchemes: [{ type: "oauth2", scopes: [] }] };
