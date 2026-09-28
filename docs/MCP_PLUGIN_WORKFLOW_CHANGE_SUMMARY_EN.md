# MCP + Plugin Workflow Change Summary

## Scope

This document summarizes the changes on `feat/mcp+plugin` relative to `origin/main`. The implementation establishes a controlled handoff between Palatial MCP and the Palatial Isaac Sim Plugin.

## Objective

The previous MCP workflow primarily supported downloading a READY asset as a local ZIP. For Isaac Sim Plugin usage, the plugin must own the authenticated export, archive extraction, and USD insertion flow. If MCP exports the asset first and the plugin imports it afterward, the same asset can trigger duplicate export operations and duplicate export-credit consumption.

The revised responsibility boundary is:

- MCP creates assets, preserves the canonical `asset_id`, polls existing jobs, and writes a handoff file.
- The plugin reads the handoff file and reuses its existing `Import existing asset` flow.
- Export ownership remains with the plugin for plugin-targeted imports.

## Changes Relative to `origin/main`

### Handoff domain module

Added `src/handoff.js` to:

- Define the versioned `palatial.isaac.handoff/v1` contract.
- Validate asset IDs, statuses, engines, source types, generation types, and export metadata.
- Generate `dashboard_url`, `import_ready`, and normalized asset metadata.
- Resolve the default path to `~/.palatial/palatial-handoff.json`.
- Use `%USERPROFILE%\\.palatial\\palatial-handoff.json` on Windows.
- Support `PALATIAL_HANDOFF_PATH` and explicit output paths.
- Write files atomically through a temporary file and rename operation.
- Apply restrictive permissions to the handoff directory and file.

### MCP tool

Added `palatial_write_isaac_handoff` in `src/mcp.js`.

The tool accepts an existing `asset_id`, retrieves the current status and available metadata, and writes the standardized handoff JSON. It sets `import_ready` to `true` only for `READY` assets.

The tool does not call `/media/export`, download a ZIP, or extract an archive. MCP guidance now routes Isaac plugin imports through this tool instead of `palatial_download_asset`.

### Client integration

Updated `src/client.js` to:

- Return Isaac plugin guidance after asset creation.
- Return handoff guidance when an asset reaches `READY`.
- Apply the same guidance to generated variants.
- Add `writeIsaacHandoff()` for status retrieval, metadata mapping, contract construction, and file writing.

### CLI integration

Added the `handoff` command to `bin/palatial-agent.js`:

```sh
palatial-agent handoff --asset-id ASSET_ID
palatial-agent handoff --asset-id ASSET_ID --output ./assets/palatial-handoff.json
```

The command writes the handoff contract without creating an export ZIP or consuming an MCP export credit.

### Agent guidance and documentation

Updated MCP instructions and the README to define the Isaac workflow as:

```text
create asset -> preserve asset_id -> poll existing job -> write handoff -> plugin import
```

Added:

- `docs/isaac-handoff.md`: authoritative handoff contract.
- `docs/PLUGIN_SIDE_PROMPT.md`: plugin implementation requirements.
- `skills/palatial-isaac-handoff.md`: agent routing guidance.
- `skills/palatial-asset-recovery.md`: failure and recovery guidance.

The ordinary local ZIP download path remains available when a local export is explicitly requested.

### Tests

Added `test/handoff.test.js` and extended `test/mcp.test.js` to cover contract validation, READY and non-READY behavior, viewer URL generation, metadata normalization, path resolution, atomic writes, the no-export guarantee, and MCP tool registration.

## Handoff Contract

```json
{
  "schema": "palatial.isaac.handoff/v1",
  "asset_id": "asset-example",
  "status": "READY",
  "import_ready": true,
  "dashboard_url": "https://dashboard.palatial.cloud/viewer/asset-example",
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

Contract rules:

- `schema` must equal `palatial.isaac.handoff/v1`.
- `asset_id` is the canonical asset identity.
- `import_ready` is `true` only when `status` is `READY`.
- `export.owner` is always `plugin`.
- `export.mcp_should_download` is always `false`.
- A non-READY handoff may preserve state, but must not trigger automatic import or replacement-job creation.
- The handoff file contains no API keys, signed export URLs, or other credentials.

## End-to-End Workflow

1. The agent creates an asset with `isaac_sim` included in `engine`.
2. MCP preserves the returned `asset_id`.
3. MCP polls the existing asset instead of creating a replacement.
4. Once the asset is READY, MCP writes the handoff JSON.
5. The plugin discovers the default file or receives it through the existing import control.
6. The plugin validates the contract and calls `import_existing_asset(asset_id)`.
7. The plugin performs the authenticated export, extraction, and USD insertion once.

MCP does not modify the Isaac Stage or extract archives in this workflow.

## Operational Benefits

- Prevents duplicate export operations and charges.
- Establishes explicit ownership between orchestration and scene import.
- Preserves asset identity and processing state across tools.
- Enables deterministic automation through a versioned local contract.
- Retains the existing plugin import path and credential management.
- Preserves local ZIP export for non-plugin use cases.

## Verification

- JavaScript syntax checks passed for the CLI and handoff module.
- 68 of 69 automated tests passed.
- The only failure was the existing Windows symlink-permission test in `test/guide.test.js`, which returned `EPERM` because the test environment does not permit symlink creation.
- The new handoff and MCP tests passed.
