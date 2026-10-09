# CF Sync

English | [日本語](README.ja.md)

An Obsidian plugin that syncs notes and attachments across devices using Cloudflare Workers, Durable Objects, and R2. You host the server in your own Cloudflare account.

https://github.com/user-attachments/assets/b756b66e-3c62-4bcb-9710-f038a03f7667

## Features

- **Concurrent editing**: Edit the same Markdown note on multiple devices, with changes synced while you type.
- **Live cursors**: Share your active editing pane and always see other devices’ cursors, selections, and names in the same note.
- **R2 storage**: Store the latest versions of notes and attachments as regular files in your own R2 bucket.
- **Offline support**: Save changes locally while offline and sync them when you reconnect.
- **Conflict preservation**: Keep attachments and other files that cannot be merged automatically under separate names.
- **Mobile support**: Works with Obsidian on iOS and Android.

For up to five devices, the targets are about 0.5 seconds for text and 0.2 seconds for cursors. These targets have not been measured; the collaboration changes still need testing on desktop, iOS, and Android devices.

## Getting started

1. [Set up the server on Cloudflare](#server-setup).
2. [Install the plugin on each device](#plugin-installation).
3. Sign in and create a remote vault on your first device. Select the same remote vault on your other devices.

## Server setup

Clone this repository and install dependencies with `pnpm install --frozen-lockfile`.

1. Enable R2 in Cloudflare and set `bucket_name` in `packages/worker/wrangler.toml` to your bucket name. To create a bucket, run `pnpm --filter @cf-sync/worker exec wrangler r2 bucket create <bucket-name>`.
2. Assign your HTTPS hostname to the Worker as a custom domain. Use this origin, without a path, as the server URL in the plugin.
3. Protect the sync API at `/api/*` with an Access self-hosted application, allow only your email address, and enable Managed OAuth.
4. Set the allowed OAuth redirect URI to `https://<hostname>/oauth/callback`.
5. Set the desired access token lifetime to 15 minutes and the Grant session duration to 30 days.
6. Configure the Worker environment variables below. For local development, put the same values in `packages/worker/.dev.vars`.

| Variable             | Value                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| `ACCESS_TEAM_DOMAIN` | Your team domain, such as `example.cloudflareaccess.com`, without a scheme |
| `ACCESS_AUD`         | The Application Audience of your Access application                        |

```sh
pnpm --filter @cf-sync/worker exec wrangler login
pnpm --filter @cf-sync/worker exec wrangler secret put ACCESS_TEAM_DOMAIN
pnpm --filter @cf-sync/worker exec wrangler secret put ACCESS_AUD
pnpm deploy
```

## Plugin installation

In Obsidian, open **Settings → Community plugins → Browse**, search for **CF Sync**, and install and enable it. If restricted mode is on, turn on community plugins first.

1. Enter your server URL and device name in the CF Sync settings, then sign in.
2. Complete Access authentication in your browser and return to Obsidian from the callback page.
3. Create a remote vault on your first device. Select the same remote vault on additional devices.
4. If existing files conflict, review the initial confirmation screen. Files with different contents are kept under separate names.

Each local vault connects to one remote vault. To use a different remote vault, create a separate local vault.

## CLI

Sync a Vault without Obsidian on macOS or Linux with Node.js 24 or later. Create an Access [service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) and allow it with a **Service Auth** policy.

```sh
npm install -g obsidian-cf-sync
export CF_SYNC_SERVER_URL=https://sync.example.com
export CF_ACCESS_CLIENT_ID='your-client-id'
export CF_ACCESS_CLIENT_SECRET='your-client-secret'

obsidian-cf-sync vault list
obsidian-cf-sync init ./vault --vault REMOTE_VAULT_ID
obsidian-cf-sync sync ./vault
```

See `obsidian-cf-sync --help` for more options.

## Remote MCP server

The Worker can expose a remote MCP endpoint at `https://<hostname>/mcp`. MCP clients sign in through Cloudflare Access and authorize read-only note access with OAuth, so the client does not need a Service Token in its environment. The MCP server exposes note listing, note reading, and content search only.

1. Register a dedicated device for the MCP server. The directory does not need to be synced, but initialization registers the device.

   ```sh
   obsidian-cf-sync init ./mcp-device --server https://<hostname> --vault <remote-vault-id>
   ```

2. Edit `packages/worker/wrangler.toml`. Set `MCP_PUBLIC_URL` to the Worker origin, and set `MCP_VAULT_ID` and `MCP_DEVICE_ID` from `./mcp-device/.cf-sync/vault.json`.
3. In the Cloudflare Access self-hosted application, protect `/api/*` and `/authorize`. Configure both the user login policy and Service Auth policy, and allow the logged-in users through `/authorize`. Leave `/mcp`, `/oauth/*`, and OAuth metadata public so MCP clients can reach them.
4. Create a KV namespace for OAuth and set its ID in the `OAUTH_KV` binding in `wrangler.toml`.

   ```sh
   pnpm --filter @cf-sync/worker exec wrangler kv namespace create OAUTH_KV
   ```

5. Set the Cloudflare Access Service Token used for the Worker’s internal sync API requests as Worker secrets, then deploy.

   ```sh
   pnpm --filter @cf-sync/worker exec wrangler secret put CF_ACCESS_CLIENT_ID
   pnpm --filter @cf-sync/worker exec wrangler secret put CF_ACCESS_CLIENT_SECRET
   pnpm deploy
   ```

Register `https://<hostname>/mcp` in the MCP client. The first connection opens a browser for Access sign-in and approval to read notes. The Worker validates the Cloudflare Access JWT signature, issuer, and audience; the MCP server manages OAuth tokens.

## Local MCP server

For stdio connections, you can use the separate `obsidian-cf-sync-mcp` package. It reads directly from the sync API and exposes only note listing, note reading, and content search. It does not expose sync or write operations.

```sh
npm install -g obsidian-cf-sync-mcp
obsidian-cf-sync init ./agent-connection --vault <remote-vault-id>
```

The initialized directory is used for its server, Vault, and device binding; it does not need to be synchronized locally. Configure the MCP client with the initialized directory and a Cloudflare Access Service Token:

```json
{
  "mcpServers": {
    "obsidian-cf-sync": {
      "command": "obsidian-cf-sync-mcp",
      "env": {
        "CF_SYNC_VAULT_DIR": "/path/to/agent-connection",
        "CF_ACCESS_CLIENT_ID": "your-client-id",
        "CF_ACCESS_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

The MCP server uses the same Cloudflare Access Service Token as the CLI. Keep it in the MCP client's environment rather than pasting it into a conversation or note.

## Requirements and costs

CF Sync requires a Cloudflare account and a server that you deploy and maintain in that account, using Workers, Durable Objects, R2, and Cloudflare Access with Managed OAuth. You also need a custom domain for the server and an email address allowed by your Access policy.

Cloudflare charges may apply depending on your plan and usage. Review the pricing for [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/), and [R2](https://developers.cloudflare.com/r2/pricing/) before deploying.

## Network access and data

The plugin communicates with your configured server over HTTPS and secure WebSockets. It sends synced file contents and paths, edits and deletion operations, file metadata, remote vault names and identifiers, device names and identifiers, cursor positions and selections in the active note, and sync exclusion settings. Your server processes this data in Cloudflare Workers and Durable Objects and stores files in your R2 bucket. Cursor information is used only for live display and is not stored in files, edit history, or R2. Durable Objects retain the Yjs state of deleted notes to recover edits made concurrently with deletion.

Sign-in uses your server's Cloudflare Access OAuth endpoints and, in your browser, the identity provider configured in Access. OAuth registration, authorization, and token exchange send the information needed to authenticate. Your Access policy controls who can sync, and your server verifies the Access JWT's signature, issuer, audience, and expiration.

CF Sync does not provide end-to-end encryption. Transport is encrypted, but the server can read synced content, and the latest notes and attachments are stored in R2 as regular files.
