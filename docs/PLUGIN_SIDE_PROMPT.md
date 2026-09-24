# Plugin-side implementation prompt

Paste the following into the Palatial Isaac Sim plugin conversation.

---

Implement MCP → Isaac plugin handoff in `D:\Plugin_things\palatial-isaac-plugin`. Do not change Palatial create, poll, or Stage-import semantics. Reuse the existing **Import existing asset** path.

## Goal

The public MCP/CLI (`palatial-agent-tools`) now writes a local JSON contract instead of downloading the export ZIP. The plugin must consume that file, extract `asset_id`, and import through the current authenticated download → extract → USD insert flow. MCP never extracts archives or edits the Isaac Stage. A MCP download plus a plugin import would spend export credit twice; this path must spend it once, in the plugin.

## Contract (`palatial.isaac.handoff/v1`)

Shared default file (MCP already writes here; the plugin must read the same path):

- Windows: `%USERPROFILE%\.palatial\palatial-handoff.json`
- Linux: `~/.palatial/palatial-handoff.json`

Do not use Isaac CWD or MCP CWD. Auto-discovery order: `PALATIAL_HANDOFF_PATH`, then that well-known file. File picker is a manual override for one import, not the default path.

Canonical identity is `asset_id` (`^[A-Za-z0-9_-]{1,128}$`). Ignore unknown fields. Reject an unknown `schema`. Parse `dashboard_url` locally with the existing `asset_id_from_dashboard_url()` helper; never fetch the URL. MCP writes `https://dashboard.palatial.cloud/viewer/{asset_id}`, which that helper already accepts. If the host is not `dashboard.palatial.cloud`, ignore the URL and use `asset_id`.

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

Rules:

- Auto-import only when `schema` matches and `import_ready === true` and `status === "READY"`.
- If the file exists but is not ready, show `status` and keep the `asset_id`. Do not create a replacement job. Do not call `/media/export` until import is actually requested/ready.
- `export.owner` is `plugin`. `export.mcp_should_download` is `false`. Do not look for a MCP-downloaded ZIP; that file is not in this contract.
- `generation_type` is optional metadata (`texttosim` | `imagetosim` | `cadtosim`) for Stage namespace only. If missing, keep current import behavior.
- Repeat-import policy stays `reject`. Credentials stay in Windows Credential Manager / Secret Service; do not read MCP `credentials.json`.
- No API keys, signed export URLs, or secrets belong in the handoff file. Never log `dashboard_url` query strings.

## Suggested seams

1. Domain parser + tests for valid, unknown-schema, not-ready, invalid id, and viewer-URL fixtures. Pure Python, no Isaac, no credits.
2. Keep `PipelineController.import_existing_asset(asset_id)` as the only import entry. Add a loader that reads the JSON and calls it.
3. UI: keep paste-URL/ID. Auto-discover the well-known `~/.palatial/palatial-handoff.json` file. Keep a file picker as an explicit override. Do not add Regenerate, reprocess, or variant UI.
4. Document the operator path in README: MCP writes the file → plugin imports existing asset.

Authoritative MCP-side spec: `D:\Plugin_things\palatial-agent-tools\docs\isaac-handoff.md`.
