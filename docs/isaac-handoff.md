# Isaac plugin handoff contract

`palatial.isaac.handoff/v1` is the local file the public MCP/CLI writes so the Palatial Isaac Sim plugin can import an existing cloud asset **without a second export**. Canonical identity is `asset_id`. The MCP client does not extract ZIPs or edit the Isaac Stage.

## File

Shared well-known path (both MCP and the Isaac plugin):

- Windows: `%USERPROFILE%\.palatial\palatial-handoff.json`
- Linux / macOS: `~/.palatial/palatial-handoff.json`

Do **not** use the process working directory. MCP CWD is the coding-agent project; Isaac CWD is usually the Isaac install directory.

**Write order (MCP/CLI):**

1. Explicit tool `output_path` / CLI `--output`
2. `PALATIAL_HANDOFF_PATH`
3. The well-known path above

**Read order (Isaac plugin):**

1. `PALATIAL_HANDOFF_PATH` (tests and operator override)
2. Manual file picker in Import (explicit user choice for that action)
3. The same well-known path

The file is overwritten atomically. It contains no API keys, signed export URLs, or credentials. `~/.palatial/` is only this handoff drop; do not store workspace keys there.

## Schema

```json
{
  "schema": "palatial.isaac.handoff/v1",
  "asset_id": "6a8f06003febd2fb7542daa9",
  "status": "READY",
  "import_ready": true,
  "dashboard_url": "https://dashboard.palatial.cloud/viewer/6a8f06003febd2fb7542daa9",
  "name": "Storage bin",
  "source": "text",
  "generation_type": "texttosim",
  "engine": ["isaac_sim"],
  "workspace_id": null,
  "export": {
    "owner": "plugin",
    "mcp_should_download": false
  },
  "written_at": "2026-09-21T08:00:00.000Z",
  "client": {
    "name": "@palatial/agent-tools",
    "version": "0.1.0"
  }
}
```

| Field | Contract |
| --- | --- |
| `schema` | Literal `palatial.isaac.handoff/v1`. Reject unknown versions. |
| `asset_id` | Canonical ID. `[A-Za-z0-9_-]{1,128}`. Same ID the plugin already accepts in **Import existing asset**. |
| `status` | Last observed `/status` string. Do not invent values. |
| `import_ready` | `true` only when `status === "READY"`. Plugin must not auto-import otherwise. |
| `dashboard_url` | Convenience. MCP writes `{origin}/viewer/{asset_id}`, which the plugin's existing HTTPS parser already accepts. Parse locally; never fetch the URL. If the host is not `dashboard.palatial.cloud`, ignore the URL and use `asset_id`. |
| `name` / `source` / `generation_type` / `engine` / `workspace_id` | Best-effort metadata from asset details. Nullable. `generation_type` is `texttosim`, `imagetosim`, or `cadtosim` when known. |
| `export.owner` | Always `plugin`. MCP must not call `/media/export` for this path. |
| `export.mcp_should_download` | Always `false`. A second download spends another export credit. |
| `written_at` | ISO-8601 timestamp of the local write. |
| `client` | Writer identity. Informational. |

## Plugin behavior

1. Keep the existing **Import existing asset** path (paste URL or raw ID).
2. Also auto-discover `%USERPROFILE%\.palatial\palatial-handoff.json` (Linux `~/.palatial/palatial-handoff.json`), or `PALATIAL_HANDOFF_PATH`. Keep a file picker for an explicit JSON.
3. If `schema` mismatches, show a contract error; do not guess.
4. If `import_ready` is false, show `status` and wait or poll; do not create a replacement asset.
5. When ready, call the existing `import_existing_asset(asset_id)` flow (authenticated export + ZIP extract + USD insert).
6. Do not consume a ZIP previously downloaded by MCP. That file is not part of this contract.
7. Repeat-import policy stays the plugin default (`reject`).

## MCP / CLI writers

```sh
palatial-agent handoff --asset-id YOUR_ASSET_ID
palatial-agent handoff --asset-id YOUR_ASSET_ID --output ./assets/palatial-handoff.json
```

MCP tool: `palatial_write_isaac_handoff`.

Coding-agent routing: create with `engine=["isaac_sim"]`, poll `palatial_get_asset`, write the handoff, never `palatial_download_asset` for Isaac import.
