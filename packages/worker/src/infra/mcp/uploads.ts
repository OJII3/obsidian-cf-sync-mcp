import { ApplicationError } from "../../domain/errors";

export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

/** Accept only ChatGPT file storage, never arbitrary model-provided web URLs. */
export function uploadUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname;
  const allowed =
    host.endsWith(".oaiusercontent.com") ||
    /^(?:oaisdmntpr|oaisdsorpr|sdmntpr)[a-z0-9-]*\.blob\.core\.windows\.net$/.test(host) ||
    /^(?:oaisdmntpr|sdmntpr)[a-z0-9-]*\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(host);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !allowed) {
    throw new ApplicationError(
      "invalid-input",
      "Upload must use a ChatGPT HTTPS file download URL",
    );
  }
  return url;
}

export async function readLimited(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!body) {
    throw new ApplicationError("invalid-input", "Missing file body");
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > limit) {
        throw new ApplicationError("invalid-input", `File exceeds the ${limit} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function fetchUpload(downloadUrl: string): Promise<Uint8Array> {
  const url = uploadUrl(downloadUrl);
  const response = await fetch(url.href, {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApplicationError(
      "invalid-input",
      "ChatGPT file download failed; attach the file again",
    );
  }
  if (Number(response.headers.get("Content-Length")) > MAX_UPLOAD_BYTES) {
    await response.body?.cancel();
    throw new ApplicationError("invalid-input", "Uploaded file exceeds 16 MiB");
  }
  return readLimited(response.body, MAX_UPLOAD_BYTES);
}
