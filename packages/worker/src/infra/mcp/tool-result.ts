import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as v from "valibot";

import { ApplicationError } from "../../domain/errors";

function result(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

export async function safe(
  action: () => Promise<Record<string, unknown>>,
): Promise<CallToolResult> {
  try {
    return result(await action());
  } catch (error) {
    let message = "Vault operation failed; retry using the same request_id or read the file again";
    if (error instanceof ApplicationError || error instanceof v.ValiError) {
      message = error.message;
    }
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}
