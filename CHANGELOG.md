# Changelog

## 0.1.0 — first public release

This release provides the Palatial public thin client for Codex CLI and Claude
Code. It runs as a local stdio MCP server, sends only explicitly selected
inputs to the Palatial API, and keeps generation and provider orchestration on
Palatial infrastructure.

### MCP tools

- `palatial_doctor` — check authentication, connectivity, package version, and
  available updates.
- `palatial_create_asset` — create text, image, multiview, or CAD assets.
- `palatial_get_asset` — poll an existing asset without creating a replacement.
- `palatial_get_asset_details` — retrieve the full asset record.
- `palatial_list_assets` — list workspace assets with search and status filters.
- `palatial_batch_get_statuses` — check up to 100 assets in one request.
- `palatial_get_pipeline_progress` — inspect stage-level processing progress.
- `palatial_create_variant` — create an independent asset variant using feedback.
- `palatial_reprocess_asset` — reprocess from a pipeline stage in place or as a
  variant.
- `palatial_download_asset` — download a READY export ZIP with a SHA-256 receipt.
- `palatial_cancel_asset` — cancel queued, active, or paused processing.

### CLI and release operations

- Private API-key login, logout, and read-only doctor checks.
- Codex CLI and Claude Code MCP registration, including dry-run setup.
- Semantic package and MCP server version alignment.
- `palatial-agent update` to check the latest GitHub Release.
- `palatial-agent update --apply` for an explicit global update.
- Cached update checks with a 24-hour interval and restart guidance.
- Release changelog and versioned GitHub Release tarball distribution.

### Safety and transport

- Local stdio transport; no local GPU, inbound port, Docker daemon, or hosted
  MCP server is required.
- HTTPS-only Palatial API requests and credential redaction in errors.
- No automatic retry of ambiguous create, variant, reprocess, or cancel writes.
- Local recovery receipts for accepted submissions.
- Export redirect credential isolation and ZIP SHA-256 verification.
- Existing output files are preserved; downloads are not silently overwritten.
- Input and download size limits, source-specific validation, units, axes,
  articulation, segmentation, texture, and decimation controls.

### Validation

- Node.js 22+ support.
- Contract and MCP transport tests with fixture-only API calls.
- Cross-platform CI on Ubuntu, macOS, and Windows.
- Clean-package installation and stdio MCP smoke validation.
- No production generation canary or native simulator acceptance is implied by
  this release; those remain separate release checks.

After updating, restart Codex or Claude Code so it launches the new MCP process.
