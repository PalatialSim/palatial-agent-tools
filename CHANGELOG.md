# Changelog

## 0.1.20-dev.0

- Send prompt, images, videos, CAD and documents in one streaming multipart request up to 64 MiB; retain resumable transport for larger files up to 1 GiB.
- Replace the fixed upload deadline with progress and response deadlines. Recover uncertain submissions using a digest manifest without resending files unless bytes are missing.
- Store file manifests instead of new inline-byte receipts; preserve exact replay of older receipts.

## 0.1.19-dev.0

- Send small PNG, JPEG and WebP files with Agent intent in the JavaScript client and MCP. Count existing inline attachments toward the shared limits.
- Keep larger photos, CAD and videos on verified multipart upload. Preserve request identity and exact input on replay.
- Document single-request photos as the recommended small-image path.

## 0.1.18

- Preserve generation descriptions beyond older client caps and relay the server-owned length validation.
- Read Mad Max combined input limits from the server contract instead of stale local guidance.

## 0.1.17 — optional Agent request identity

- Make `request_id` optional for `palatial_agent` and `requestId` optional for the JavaScript client. Each omitted-ID submission is new work; explicit identical IDs and input retain idempotent replay and billing protection.
- Forward omission to the server for ordinary intents. Local-file transport creates one identity per call and shares it across reservation, upload and submission without mutating caller input.
- Keep poll-only calls and native source-reservation requirements unchanged. Mutations are never retried automatically.

## 0.1.16 — one native unattended Agent entry

- Expose exactly one MCP tool, `palatial_agent`, for asset intent and polling. The server always executes unattended against saved project data through shared owning services; no caller execution policy, answers, selections or confirmations.
- Use `POST /external/agent` and `GET /external/agent/{id}`. The old `/agent/turns` path is removed without an alias. Legacy JavaScript/CLI operations remain available outside the MCP catalog.
- Integrate explicit local image/CAD/video files as transport: native unpaid reservation, verified multipart upload and saved exact-input replay after response loss. No API key is forwarded to storage and mutations are never automatically retried.
- Preserve host-owned structured media/download outcomes and native billing pauses. Keep this new Backend contract explicitly Dev-preview until owning promotion.

## 0.1.15 — optional Variant batch count

- Let the server model infer omitted batch `count` from feedback without a
  client-side default. An explicit count still wins and remains validated.
- Preserve omitted count through direct submission, optional free previews,
  signed-quote submission and exact idempotent replay.
- Explain `VARIANT_BATCH_COUNT_REQUIRED` for ambiguous requests and retain
  the normal server count cap, queueing and independent child billing.

## 0.1.14 — direct Variant batch submission

- Submit Variant batches with count, feedback and a stable `request_id` in one
  call; the server owns planning, pricing and admission when `quoteId` is omitted.
- Keep free `dryRun` previews and explicit signed `quoteId` submission available
  for callers who want to inspect and freeze a plan first.
- Preserve idempotent replay, independent child billing and queue semantics;
  mutation failures are never retried automatically by the client.
- Make direct submission primary in tool guidance and packaged examples.

## 0.1.13 — quoted Variant batches

- Add `palatial_create_variant_batch` and `palatial_get_variant_batch`, with
  matching API-client methods for server-owned batches of independent variants.
- Preview distinct model-generated requirements and total/per-item estimates
  with a free `dryRun`; submit the approved `quoteId` with a stable
  `request_id` sent as `Idempotency-Key`.
- Preserve queued children, partial failures, Viewer links and actionable
  server errors without client-side creation loops or automatic mutation retries.
- Document quote approval, per-child billing and safe replay in `palatial_guide`.
  Release after the batch API is deployed and verified.

## 0.1.12 — automatic mode on existing creation APIs

- Add `mode: auto` to the existing `palatial_create_asset` tool for text,
  photos and CAD, with optional quality/engine goals and free `dryRun`.
  Existing local file argument names are preserved and uploaded as unified
  `files`; HTTPS source URLs are passed as `urls`.
- Reuse the same automatic submission, idempotency identity, receipt and
  typed-error handling for the primary tool and `palatial_create_auto` shortcut.
  Both use the existing `/external/assets/create` with `mode: auto`.
- Keep explicit-mode creation and legacy `shape_model: auto` semantics.
  Automatic mode refuses manual settings, named views, video, shape guides and
  file-purpose overrides instead of dropping inputs or selecting defaults.
- Document the existing-API contract and automatic examples in the shared guide.
  Release only after those API routes serve automatic mode in the target environment.

## 0.1.11 — automatic asset generation

- Add `palatial_create_auto` and `PalatialClient.createAuto` to submit text,
  local photos/CAD or HTTPS sources to the shared automatic-generation API.
  The server selects the mode, required settings and reason; the client
  contains no route selection rules.
- Support free `dryRun` selection without asset creation or local submission
  receipts. Submissions send a stable `Idempotency-Key`, retained before the
  request and returned with the asset so identical replays recover uncertainty.
- Preserve typed selection errors and correction remedies, and document
  automatic selection, dry runs, input limits and replay recovery in the
  packaged MCP guide and Claude skill.
- Keep an existing asset ID in replay errors so its status can be inspected;
  allow automatic intake/selection three minutes without changing ordinary
  create or read deadlines.
- Release only after the target API serves `POST /external/assets/create/auto`.

## 0.1.10 — scene create-and-start and declared input purposes

- Converge the scene MCP surface to create-and-start, status, Stop and download,
  plus optional manual answers. New creates call the shared Nest one-shot start
  endpoint with local files or HTTPS source URLs and optional `auto_continue`.
- Stream large local files to the returned signed storage URL without forwarding
  the API key. Upload completion automatically starts the scene; callers never
  need generate, multipart operations, recover or retry-start.
- Preserve stable scene request UUIDs and explicit spending authorization.
  Previously uploaded source descriptors and legacy list/recover/retry client
  methods and cached deprecated tool calls remain compatible, while fresh MCP discovery omits them.
- Make download version optional while retaining accepted SHA-256 version,
  ETag, byte count, package digest and cached-receipt verification.
- Rewrite the packaged scenes guide around the four-operation flow and cover
  inline/URL start, signed streaming and failure identity, manual answers,
  cancellation, download integrity and deprecated client compatibility.



- Add `source: files` to `palatial_create_asset`: photos, 3D files and PDF
  datasheets in one `files` list, each 3D file with an optional `purpose`
  (`exact_geometry`, `shape_reference` or `unused`). It posts to the API's
  unified `POST /external/assets/create`, which chooses the route from the
  purposes with the same rules as the Palatial Dashboard and refuses an unclear
  purpose with `BUILD_INPUT_PURPOSE_REQUIRED`. Release this only after that
  endpoint serves the target environment; `text`, `image` and `cad` are unchanged.
- A `shape_reference` may also be a STEP, OBJ, STL or PLY file; the API converts it
  to a GLB before the Mad Max build reads it.

## 0.1.9 — create modes and live documentation checks

- Add explicit create modes with route-specific, typed parameters. The MCP
  requires modes for text/image and omits redundant shape/texture-model fields;
  the CLI/API client keeps legacy request files. Reject unsupported settings
  before submission.
- Simplify the MCP to rigid assets without body_type, auto_scale or replace_glass.
  Offer auto/low/medium/high/sdf collision quality; auto omits the API override
  (currently medium for Diffusion/Low). Keep legacy client requests compatible.
- Surface native research/build job status on INIT and detailed asset reads,
  including failures hidden by an asset still reporting INIT. Preserve both
  states, validate job/asset binding and report inaccessible job status as unknown.
- Add MP4/MOV video input and Mad Max scanned GLB references; enforce mode,
  research, photo-count, engine and face-budget limits.
- Check docs.palatial.cloud on every MCP startup with persistent article hashes,
  changed-page excerpts, offline fallback, palatial_check_docs and CLI docs.
  The packaged skill directs agents to the live API reference.


- Share the validated reprocess feedback schema across MCP and the API client;
  add `palatial-agent reprocess --asset-id ID --request repair.json`.
- Align reprocessing with the overwrite-only API; independent versions use
  `palatial_create_variant`. Feedback edits require an explicit stage and carry
  the selected source run and supported processing settings.

- Preserve sanitized billing metadata, advisory balance warnings, and financial
  error codes through the client, submission receipts, and MCP responses.
- Record definite generation-start rejections as `rejected`, with consistent
  top-up guidance in MCP. Keep recovery guidance for uncertain submissions.
- Explain route start minimums, postpaid stage charges, normal checkpoint
  auto-resume, and same-asset resumption after a posted top-up leaves the
  shared net balance positive. Export itself does not consume tokens; a later
  paused run can use an earlier export only while the server exposes its key.
- Retire the public Parametric `medium` effort; new requests use `low` or
  `mad_max`.
- Wrap array-valued list and batch results in MCP `structuredContent` records
  while keeping their raw JSON in the text response, as required by the MCP
  result schema.

- A 4xx response now carries the API's own reason, for example
  `Invalid request (HTTP 400). BAD_REQUEST: <message>`. Only the structured
  `code` and `message` fields are read, bounded to 500 characters and
  redacted; any other response body stays out of the error.
- A create the API rejects with a 4xx records `status: rejected`, the HTTP
  status and the reason in its recovery receipt instead of
  `submission_outcome_unknown`, since nothing was created.


## 0.1.8 — reprocess wording for researching jobs

- The `palatial_reprocess_asset` description, README and troubleshooting
  guidance match the API: without `from`, a researching job retries its failed
  or stopped model build, delivery or completion, whether or not it already
  has pipeline work; with `from`, the call always reprocesses that stage.

## 0.1.7 — stop and retry researching jobs

- `palatial_reprocess_asset` accepts a request without `from`. A researching
  job (`effort: mad_max`, or a create with a video) that failed before it
  reached the pipeline retries its failed research or model build that way,
  at the same price as the Dashboard retry. Every other asset still needs a
  stage, and the API says so.
- `palatial_cancel_asset` is documented to stop a researching job that is
  still researching or waiting for its build to start, which the API now
  supports.
- `palatial_get_asset` reports `generation_route` while a job runs, because
  the status route the tool polls now carries `generationAgent`.

## 0.1.6 — product research mode

- `palatial_create_asset` accepts `product_research` (`on`, `specs_only`, or
  `off`) on an image request with `effort: mad_max`. `on` is the default and
  researches the real product on the web, its pages and its product photos.
  `specs_only` reads the web for identity and specifications but uses no web
  images, so the model is built only from the uploaded images. `off` looks
  nothing up and builds from the uploaded images and description alone.
- A narrowed mode on any other route, or without images, is refused before
  anything is sent, because the API would accept it and do nothing.
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
