# Changelog

## Unreleased

- Preserve sanitized billing metadata, advisory balance warnings, and financial
  error codes through the client, submission receipts, and MCP responses.
- Explain postpaid stage charges and same-asset resumption after a posted top-up
  leaves the shared net balance positive. Export itself does not consume tokens;
  existing exports remain downloadable during a later paused run.

## 0.1.5 — public generation route on asset reads

- The API now publishes how an asset was built as `generationAgent`
  (`diffusion`, `parametric`, or `mad_max`) and names the Mad Max progress
  blocks `madMaxBuild`, `madMaxBuildHistory`, and `madMaxSimulation`.
  `palatial_get_asset` surfaces the label as `generation_route` with a note on
  how to request that route again; records without the field are unchanged.
- `mad_max` is a route label, not a `shape_model` value. A request that copies
  it into `shape_model` is refused before anything is sent, with the correct
  form (`shape_model: parametric`, `effort: mad_max`) in the message.
- `generationRoute()` and `createOptionsForRoute()` are exported from the client
  for integrations that translate a finished asset into a new request.
- Packaged guidance covers reading the route back and warns against replaying a
  record's `parameters` block as a create.

## 0.1.4 — WebP reference images

- `palatial_create_asset` accepts WebP reference images for single-image,
  named multiview, Parametric multi-image, and CAD reference requests, and
  uploads them as `image/webp` multipart parts. Its schema and packaged
  guidance now match the external create contract.
- The guidance now marks the legacy `reconstruct` field as ignored by the
  current Queue. Supplied views still reach generation; one image does not
  trigger synthetic view generation.

## 0.1.3 — direct create route capabilities

- `palatial_create_asset` now forwards `effort` for Parametric text and image
  builds (`low`, `medium`, `mad_max`) and `reconstruct` for image requests.
- CAD reference images are optional. Without one, the client uploads only the
  mesh and leaves texture generation off by default. Direct meshes may specify
  an exact `meters_per_unit` instead of named `units`.
- A GLB that contains bound embedded textures can request appearance preservation;
  the API inspects the bytes before accepting it. Other direct mesh formats
  still cannot prove external texture sidecars from one upload.
- The MCP schema, packaged guidance, and transport tests reflect these routes.

## 0.1.2 — create parameter parity

### Create parameter parity

- `palatial_create_asset` accepts `body_type`, so a request can ask for a soft
  object (cloth, garments, cable, rope) rather than only a rigid one, with
  `newton_solver` beside it. The API silently swaps a solver the body type
  cannot use, so a contradictory pair is refused here and the error names the
  value that body type accepts.
- `repair_mesh`, `replace_glass`, and `auto_scale` are accepted on every source.
- CAD requests accept `regenerate_parts`, `keep_existing_textures`,
  `keep_existing_shape`, and `physics_validation_only`, so a mesh that is
  already correct can go through collision, physics and validation without
  having its appearance or parts rebuilt. The combinations that contradict each
  other are refused before anything is spent.
- The parameter reference documents all nine, the worked requests gain a soft
  object and a keep-what-was-supplied CAD example, and the existing test that
  pins the reference against the schema now covers them.
- Keeping a CAD appearance is refused up front on the formats that cannot carry
  one. A direct mesh is a single uploaded file, so it cannot prove the material
  and texture sidecars an authored appearance lives in, and the API refuses the
  request. `keep_existing_textures`, `physics_validation_only`, and
  `apply_textures: false` are now rejected for OBJ, GLB, GLTF, STL, PLY, and FBX
  with a message naming the formats that do work, rather than reaching the API
  as an error code with no field attached.

Deliberately still not accepted: `quad_topo`, which the API rejects at any value
but its default; `reconstruct`, which the file inputs already decide;
`meters_per_unit` and `source_up_axis`, which are the canonical forms of the
`units` and `up_direction` fields already accepted.

## 0.1.1 — agent usage guidance

### Agent guidance

- Packaged usage guidance under `skills/palatial/`: a workflow overview, a full
  `palatial_create_asset` parameter reference with defaults and cross-field
  rules, worked requests for each input type, and a troubleshooting guide.
- `palatial_guide` MCP tool, so any client including Codex CLI can read that
  guidance locally without an API call.
- `palatial-agent guide [--topic <topic>]` prints the same guidance as Markdown,
  so a person can read what their agent reads without a key or a network call.
- The same four documents are published as `palatial://guide/*` MCP resources.
- `palatial-agent setup` installs the guidance as a Claude Code skill in
  `~/.claude/skills/palatial`, refreshes its own copy on a later run, and
  refuses to overwrite a skill it did not write.
- Claude skill ownership now uses a package marker plus per-file SHA-256 hashes,
  rejects symlink and edited-file targets, stages the whole tree before an
  atomic replacement, permits an intentional symlinked Claude config root,
  refreshes owned installs across package file additions/removals, and makes
  partial setup return a nonzero status.
- Create validation now matches source-specific API rules, including field
  applicability, workspace/name constraints, and format-specific CAD units and
  up-axis requirements.
- Failed assets require explicit user confirmation through
  `allow_failed_export` before the client can make a billable export request.
- Parameter guidance records effective collision and mesh defaults without
  exposing internal provider routing, and guide responses no longer duplicate
  the full document in structured output.
- Server instructions now point a client at the guidance before its first
  create call.
- Tests assert that the parameter reference documents every field and every
  closed value the create schema accepts, so a new parameter cannot ship
  undocumented.
- The folded-in asset recovery notes replace the unreferenced
  `skills/palatial-asset-recovery.md`, which no client ever loaded.

### Changed

- `palatial-agent setup --dry-run` now prints an object with `commands`, plus
  `claude_code_skill` when Claude Code is in scope, instead of a bare array.

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
- Clean-package installation and stdio MCP smoke validation, built from the
  current checkout on every supported CI operating system.
- No production generation canary or native simulator acceptance is implied by
  this release; those remain separate release checks.

After updating, restart Codex or Claude Code so it launches the new MCP process.
