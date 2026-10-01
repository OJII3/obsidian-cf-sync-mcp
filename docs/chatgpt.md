# Connect ChatGPT to a CF Sync vault

CF Sync exposes a remote Model Context Protocol (MCP) endpoint at
`https://<hostname>/api/mcp`. It lets ChatGPT list and search your remote vaults,
read Markdown, follow supported note links, and make authorized file changes.
An Obsidian app does not need to stay open for these operations.

The endpoint uses the existing Cloudflare Access application and Managed OAuth.
It does not require a second identity provider, a custom OAuth bridge, or a
long-running MCP session. Use a ChatGPT account and workspace that allow
developer-mode MCP connections.

## Deployment and verification status

This guide describes the implementation in this checkout. This change does not
deploy it, change your Access configuration, or establish that live ChatGPT
authentication and synchronization have passed. Complete the checks below
against your own deployment before relying on it for important notes.

## Set up the connection

1. Complete the [server setup](../README.md#server-setup), including your HTTPS
   custom domain, the Access application protecting `/api/*`, Managed OAuth,
   `ACCESS_TEAM_DOMAIN`, and `ACCESS_AUD`. Deploy a version of the Worker that
   includes the MCP endpoint when you are ready to test it.
2. In ChatGPT, open **Settings → Security and login** and enable **Developer
   mode**. Availability depends on account and workspace policy.
3. Open [ChatGPT Plugins](https://chatgpt.com/plugins), select the plus button,
   and add the public MCP URL `https://<hostname>/api/mcp`. Choose OAuth and
   dynamic client registration when the connection form offers that choice.
4. Copy the **exact OAuth callback URI shown for this connection** into the
   existing Access application's **Managed OAuth → Allowed redirect URIs**.
   Enable dynamic client registration if it is not already enabled. Preserve
   the Obsidian redirect `https://<hostname>/oauth/callback`; add the ChatGPT
   callback rather than replacing it.
5. Complete the connection's browser login with the identity already allowed
   by your Access policy. Review the requested access and discovered tools.
6. In a new ChatGPT conversation, add the MCP connection from the tools menu.
   First ask it to list your vaults and read a disposable test note. Test writes
   only after reads and authentication work.

Do not guess the callback URI. ChatGPT can use either
`https://chatgpt.com/connector/oauth/{callback_id}` or
`https://chatgpt.com/connector_platform_oauth_redirect`, depending on the
authorization server's issuer-identification support and the connection. Use
the value shown in ChatGPT, and avoid a broad `https://chatgpt.com/*` allowlist.
See OpenAI's [connection setup](https://developers.openai.com/plugins/deploy/connect-chatgpt)
and [OAuth requirements](https://developers.openai.com/plugins/build/auth).

### Managed OAuth discovery

`/api/mcp` is deliberately inside the existing protected `/api/*` path. Keep
Access protection in place for both this endpoint and the file-download route.
No public bypass rule is needed for MCP tool calls.

For an unauthenticated non-browser request, Access should return `401` with a
`WWW-Authenticate` header containing a `resource_metadata` URL. The client
follows that URL to discover the authorization server, registers its OAuth
client, and performs the authorization-code flow with PKCE. Follow the URLs
actually returned by Access instead of hard-coding alternative metadata.

Cloudflare documents a resource-metadata route at
`https://<hostname>/.well-known/cloudflare-access-protected-resource/` and
authorization-server metadata on the team domain. Verify that the advertised
metadata includes a registration endpoint, authorization-code flow, and `S256`
PKCE support. ChatGPT requires `S256` to be advertised. Do not put an additional
login gate in front of discovery or overwrite Access's OAuth challenges.

Access resolves the client's opaque OAuth bearer token and supplies
`Cf-Access-Jwt-Assertion` to the Worker. The existing middleware verifies the
assertion's signature, issuer, audience, expiration, and subject presence before any MCP
operation. A service token used by the CLI is not the ChatGPT login method.

See Cloudflare's [Managed OAuth guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
and [documented discovery flow](https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/).

## Tools and expected workflow

| Tool            | Purpose                                                        |
| --------------- | -------------------------------------------------------------- |
| `list_vaults`   | Find the remote vault to work in                               |
| `list_files`    | Inspect current vault files and identifiers                    |
| `search`        | Search a bounded set of current text using literal matching    |
| `read_file`     | Read current Markdown/text and obtain its file ID and revision |
| `list_links`    | Extract supported note links from a file                       |
| `resolve_link`  | Resolve a supported link against the vault's current files     |
| `create_note`   | Create a Markdown note                                         |
| `update_note`   | Update an existing note using its expected revision            |
| `upload_file`   | Import a ChatGPT-provided file into the vault                  |
| `delete_file`   | Delete a file through the existing sync operation pipeline     |
| `download_file` | Obtain an authenticated browser download URL                   |

Use returned vault IDs and file IDs rather than guessing them. The tool schema
returned by the running server is authoritative for arguments and result fields.

For example:

- “List my vaults, then find notes containing the exact phrase ‘project alpha’.”
- “Read that note and list its links. Resolve the link to the planning note.”
- “Create `ChatGPT test.md` with a short checklist.”
- “Read `ChatGPT test.md`, add a final checklist item, and save it only if the
  version you read is still current.”
- “Import this attached file into my vault, then give me its download link.”

### Concurrent edits and storage

Lists, search, and text reads use the current Durable Object state, rather than
the periodically flushed R2 archive. A returned write result confirms the
operation was accepted by the sync state; it does not by itself mean the latest
archive object is already written to R2.

An edit must identify the existing `file_id` and supply the `base_revision`
obtained from the latest read. The server checks that revision inside the
Durable Object's serialized operation queue before applying a whole-note edit.
If another device changed the note, re-read it, reconcile the intended change,
and try again with the new revision. Never retry a stale replacement blindly.

Accepted Markdown changes are expressed as a Yjs difference and use the
existing operation pipeline. They notify connected devices and schedule the
normal R2 flush. Deletion and binary-file conflicts retain the existing
preservation rules; inspect the returned file/path rather than assuming a
requested overwrite or deletion produced no conflict copy. See the
[sync protocol](protocol.md) for the underlying behavior.

## ChatGPT device and revocation

MCP operations automatically use a stable device named **ChatGPT**, with the
default ID `dc68a69e-2a40-4b66-9fe1-664d401fa360`. It participates in existing
device registration and revocation. It does not create a new device for each
conversation or reconnect.

Revoking this device blocks subsequent MCP operations. A revoked ID cannot be
registered again automatically. To intentionally restore access after
revocation, set the Worker's optional `MCP_DEVICE_ID` environment variable to a
new UUID and redeploy. This creates a new device identity; use rotation only
when you intend to authorize access again. OAuth linking alone does not undo a
device revocation.

The device identity is shared by MCP connections to this server. It is not a
per-conversation or per-ChatGPT-account permission boundary. Access policies and
the Worker JWT verification remain the authentication boundary. The single-owner restriction comes from the configured Access policy.

## Uploads, downloads, and limits

- **Text limit:** 1 MiB per text operation.
- **Upload limit:** 16 MiB per imported file. These are MCP limits, not a change
  to the existing sync API's attachment limits.
- **ChatGPT file input:** `upload_file` declares its top-level file parameter
  in `_meta["openai/fileParams"]`. The file object declares `download_url`,
  `file_id`, `mime_type`, and `file_name`; only `download_url` and `file_id` are
  required. ChatGPT supplies a temporary URL, and the Worker fetches the bytes.
  Imports accept only the implementation's permitted OpenAI download hosts;
  redirects are rejected. An arbitrary web URL is not a supported upload.
- **Download output:** `download_file` returns
  `https://<hostname>/api/mcp/files/<vaultId>/<fileId>`. Open it in your browser
  and sign in through Access when prompted. The URL is not a public share link
  and does not contain an embedded login token. This integration does not
  promise a native downloadable ChatGPT attachment or that ChatGPT can fetch
  the browser-authenticated link itself.
- **Search:** bounded literal text matching, not semantic retrieval, a complete
  indexed search service, or binary-document extraction. Refine the request
  when limits are reached; no match in a bounded scan is not proof that an
  entire large vault has no matching content.
- **Links:** a supported subset of Obsidian/Markdown note links, not every
  plugin-defined syntax or a full Obsidian renderer. Check unresolved or
  ambiguous results before editing another note. `list_links` examines at most
  128,000 characters and 200 links and reports `truncated`; ambiguous resolutions
  return at most 10 candidates plus their total count.
- **Binary content:** storage and downloads are supported; the MCP server does
  not perform OCR or extract text from PDFs, images, or other binary formats.
- **Sessions:** each HTTP request is authenticated. No live Obsidian editor,
  cursor-presence connection, or always-open MCP session is required.

OpenAI documents the file input contract in its
[file API reference](https://developers.openai.com/plugins/reference#file-apis).
File URLs can expire, and optional file-library/UI helpers vary by account;
reselect or reattach the file if a temporary upload URL is no longer valid.

## Security and data handling

Connecting this server gives ChatGPT access to the vault data permitted by the
connection. Files and text returned by tools are shared with ChatGPT, and files
imported from ChatGPT are sent to your Cloudflare-hosted server. Review those
services' data settings before using sensitive material.

The server validates input and authorization independently of tool annotations.
Read-only and destructive annotations help ChatGPT choose appropriate tool and
confirmation behavior, but they are not access-control enforcement. Review
write requests carefully, especially deletion or replacement. CF Sync still
does not provide end-to-end encryption.

## Local verification

From the repository root, run the existing checks after installing dependencies:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build:worker
```

`build:worker` uses `wrangler deploy --dry-run`; it does not publish the Worker.
These commands are a checklist, not a record of successful test execution.
Unit/integration tests and a local Worker cannot establish that a production
Access application is configured correctly or that ChatGPT account linking
works.

Use [MCP Inspector](https://developers.openai.com/plugins/deploy/connect-chatgpt)
with Streamable HTTP to inspect the authenticated endpoint. A local test may
need an appropriate authentication fixture; do not weaken production JWT
validation merely to connect an unauthenticated inspector.

## Manual end-to-end checklist

Use a disposable vault or test files and record the tested Worker version.

- [ ] An unauthenticated request to `/api/mcp` receives an OAuth discovery
      challenge instead of a browser-only redirect or an uninformative error.
- [ ] Discovery endpoints are reachable, metadata is consistent, and the exact
      ChatGPT callback is allowed alongside the existing Obsidian callback.
- [ ] ChatGPT completes Access login, discovers all tools, lists vaults, and
      reads a current note. An identity outside the Access policy cannot connect.
- [ ] Missing, invalid, expired, or wrong-audience assertions cannot read or
      mutate data, including through alternate Worker hostnames.
- [ ] A change from Obsidian is immediately visible to MCP reads without waiting
      for R2 flush. A ChatGPT edit reaches a connected Obsidian device and later R2.
- [ ] A note changed after `read_file` rejects a stale `update_note`; re-reading
      and reconciling preserves the other device's edit.
- [ ] Concurrent creation, deletion, and binary replacement preserve the existing
      conflict-copy behavior. Inspect the result and synchronized files.
- [ ] Supported links resolve; missing, ambiguous, and unsupported links are
      handled without guessing. Search limits and incomplete scans are apparent.
- [ ] A small ChatGPT file imports correctly; disallowed hosts, redirects,
      malformed paths, expired URLs, and files over the limits fail safely.
- [ ] A download opens after browser Access login and requires authentication in
      a fresh browser session. Test text and binary bytes, names, and MIME types.
- [ ] The ChatGPT device remains stable across calls. Revoking it blocks later
      calls; reconnecting OAuth does not silently re-register it.
- [ ] Token refresh works after the Access token expires. Browser login is
      requested again when the grant expires or is revoked.
- [ ] Existing Obsidian login, CLI sync, device revocation, notifications, and R2
      flushing still work.
