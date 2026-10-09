import * as v from "valibot";

const nonempty = v.pipe(v.string(), v.minLength(1));

export const credentialsSchema = v.object({ clientId: nonempty, clientSecret: nonempty });

export type Credentials = v.InferOutput<typeof credentialsSchema>;

export type CliAuth =
  | { method: "service-token"; credentials: Credentials }
  | { method: "access-token"; token: string };
