---
name: palatial
description: Generate simulation-ready 3D assets from text, images, or CAD with the Palatial MCP tools, and choose the right palatial_create_asset parameters. Use when a task needs a 3D asset for Isaac Sim, MuJoCo, or Newton, or when creating, tracking, reprocessing, or downloading a Palatial asset or scene from video, photos or a floor plan.
---

# Palatial asset generation

Palatial turns a text prompt, reference images, or a CAD file into a
simulation-ready 3D asset and exports it as a ZIP. These tools are a thin
client: they validate input, upload only the files named in the request, and
download results. Generation runs on Palatial servers.

## Before anything else

Run `palatial_doctor` once per session. It is read-only and confirms the
workspace key works. If it reports that Palatial is not authenticated, tell the
user to run `palatial-agent login` in their terminal. Never ask for an API key
in conversation and never put one in a tool argument.

## Check the current docs

Use [docs.palatial.cloud](https://docs.palatial.cloud/) as the live reference,
especially [Using the API](https://docs.palatial.cloud/integrations/api/) before
choosing a generation mode or build setting. The MCP checks the site's sitemap
and article content on every startup. `palatial_doctor.docs` reports that check;
`palatial_check_docs` refreshes it and returns changed pages with added/removed
excerpts, including the startup result. The CLI equivalent is `palatial-agent docs`.

When `changed` is true, read the affected pages directly before using their
options. Compare their request rules with the installed tool schema and report
any mismatch. If the check is unavailable, say that live docs could not be
verified and use the packaged reference. A first successful check establishes a
baseline; it does not prove the docs have never changed. Docs checks use no
Palatial key and consume no generation tokens.

## The one workflow

When the user wants Palatial to choose the generation method and settings,
use `palatial_create_asset` with `mode: auto`, their `source` and description
or existing local input arguments (`image_path`, `image_paths`, `mesh_path`,
or `files`). HTTPS `source_urls` on public hostnames work without local uploads. Set optional
`engine` and `quality` (`speed`, `balanced`, or `accuracy`) goals, and no build
settings. With media, `name` and `description` are optional; text-only input
needs a description. The server uses the shared Dashboard selection policy and
returns `selection.mode`, optional `selection.effort`, effective
`selection.settings` and `selection.reason`, including fixed-setting reasons.
Read `references/recipes.md`; CAD may need `source_up_axis` and
`meters_per_unit` describing its authored frame.

Automatic mode uses the existing unified `POST /external/assets/create`,
with `mode: auto`, `files` uploads or `urls`. Existing `texttosim` and
`imagetosim` API aliases also accept `mode: auto`. `palatial_create_auto`
remains a compatibility shortcut using its existing `file_paths` arguments,
and now calls the same unified API. The former `/create/auto` API is retained
for compatibility; it is not needed for new callers.

For MCP automatic requests, omit `parameters`, `effort`, legacy models,
`product_research`, file-purpose overrides, video, shape guides and named views.
Use explicit modes for those controls. This client refuses unsupported fields
instead of dropping input or selecting a fallback. Legacy `shape_model: auto`
keeps its previous provider/model behavior; it does not request the semantic
selector. Use `mode: auto` to ask the server to choose a generation method.

- `dryRun: true` returns the selection without creating an asset, submitting a
  job or charging tokens. It needs no `request_id` and writes no submission receipt.
- Omit `dryRun` to create and submit directly, with ordinary creation validation,
  stage billing and retry behavior. Keep `asset_id` and poll it as below.
- Supply a stable `request_id` for each intended submission. The client sends
  it as `Idempotency-Key`. If omitted, it generates one once and saves a local
  receipt before the request. Identical replays reuse the same asset; changed
  inputs with the same ID conflict. After a lost response, replay the original
  inputs with that same ID rather than generating a replacement ID.
- A selection error includes a typed `code` and a `remedy` (or `hint`) with the correction.
  Report the error and correct the input; do not substitute a default route.
  If a replay error includes `asset_id`, inspect that existing asset with
  `palatial_get_asset`; preserve both the asset ID and `request_id`.

1. `palatial_create_asset` without `dryRun: true` submits the job and returns an
   `asset_id`. It does not wait for the asset to be built.
2. Save that `asset_id` in your reply and in any file you are writing. It is the
   only handle to the job.
3. `palatial_get_asset` polls it. Runtime depends on the chosen generation mode;
   see the mode guidance below.
4. When status is `READY`, `palatial_download_asset` saves the export ZIP and a
   SHA-256 receipt into a directory the user chose. A later paused run can use
   an earlier export only while the server exposes its materialized `export.key`.

If an asset remains INIT, inspect generation_job from get_asset or
get_asset_details. A failed native job is a failure even while the asset
remains INIT; report its error and preserve both IDs. A question or an
automation block needs attention in the dashboard. Reads do not retry it.
Mad Max researches a real product: supply a useful identity, product page
or photo. A generic description can fail with product_research_evidence_missing
when research cannot retain a usable product view, before any 3D build starts.

For several assets at once, poll with `palatial_batch_get_statuses` instead of
one call per asset. For a stuck job, `palatial_get_pipeline_progress` shows
which stage it is on.

## Several variants of one asset

Use `palatial_create_variant_batch` for one request producing N independent
child assets. Do not loop over `palatial_create_variant`. The server validates
the same source prerequisites as a single Variant, splits feedback into distinct
requirements with its model, and owns queueing and per-child stage billing.

1. With user authorization to generate the batch, submit `asset_id`,
   `feedback`, optional `count` and `parameters`, and a stable `request_id` (for example a
   UUID). The client sends `request_id` as `Idempotency-Key`. The server plans
   distinct requirements, prices and starts the batch in one request. A separate
   quote call is optional. Explicit `count` wins. When omitted, the server model
   infers the number from feedback within the normal server maximum. Never
   infer or default a missing count in the client. If the server returns
   `VARIANT_BATCH_COUNT_REQUIRED`, ask how many variants the user wants and
   supply that count. Invalid supplied counts are rejected rather than inferred.
2. When the user wants a preview first, call with `dryRun: true`. This creates
   no assets and charges nothing. Show the requirements, `totalEstimatedTokens`,
   each item's `estimatedTokens`, and the quote expiry. The estimate is not
   prepaid. To submit that frozen plan, send the same feedback, parameters and count presence/value
   as the preview with the complete opaque signed `quoteId` and a stable
   `request_id`. Preserve the full quote; do not shorten it to an ID. An expired
   explicit quote needs a new preview; do not silently drop it to submit a
   different plan.
3. Poll `palatial_get_variant_batch` with the source `asset_id` and returned
   `batch_id` (`id` in the API response). Report the individual child asset IDs,
   requirements, states and Viewer URLs. `queued` means waiting for a family
   slot, not a failed request. A queued item can expose a reserved asset ID
   before its child exists; its Viewer URL appears after admission. The
   server's batch maximum defaults to 8; its
   concurrent limit is separate, so accepted work beyond that limit queues.
4. A failed item leaves siblings running. Report its error without claiming the
   entire batch succeeded or automatically starting paid replacement work.
   If submission times out, preserve the exact payload and `request_id`; an
   identical replay retrieves the existing batch without duplicate charges.
   A changed payload with that key conflicts. Never switch keys after uncertainty.

Direct submission with the number expressed in feedback:

```json
{"asset_id":"SOURCE_ID","feedback":"Create three vase variants with different belly widths","request_id":"YOUR_STABLE_UUID"}
```

Optional preview:

```json
{"asset_id":"SOURCE_ID","count":3,"feedback":"Create three vase variants with different belly widths","dryRun":true}
```

Submit the previewed plan:

```json
{"asset_id":"SOURCE_ID","count":3,"feedback":"Create three vase variants with different belly widths","quoteId":"RETURNED_QUOTE_ID","request_id":"YOUR_STABLE_UUID"}
```

## Rules that cost the user money when broken

- Generation uses the shared organization/workspace net token balance.
  `palatial_create_asset`, `palatial_create_variant`, `palatial_create_variant_batch`, and
  `palatial_reprocess_asset` charge only for successfully completed stages.
  Reads and export itself do not consume tokens.
- New generations need a route start minimum: Diffusion 20, Parametric Low 40,
  Mad Max 80, or CAD to Sim 4 tokens. The minimum admits the run; the estimate
  is not prepaid. A `low_recommended_balance` warning recommending 10 or 20
  tokens is advisory.
- At zero or negative balance, new jobs are blocked and the next stage waits.
  An already-running stage can finish and leave debt. A normal
  `PROCESSING_PAUSED` checkpoint has `billing.paused: false` and
  `run.awaitingContinue: true`; Palatial continues automatically in about a
  minute while the balance is above zero, so keep polling. For
  `billing.paused: true` with `pauseReason: insufficient_credits`, show
  `billing_guidance` and keep polling the same asset ID. Posted credit covers
  debt first; once the net balance is positive, processing resumes automatically.
  Do not start checkout, reprocess, or create a replacement to resume it.
- A first export requires a positive net balance. An earlier export remains
  downloadable during a later run only when the server exposes `export.key`.
  Let the server check eligibility; do not infer it from `export.status` alone.
- A generation-start `insufficient_tokens` error is identified by
  `tokens.required`. It includes the route minimum, balance, and shortfall and
  means that nothing was created; add tokens and submit once. Its local
  submission receipt is marked `rejected`. Do not promise automatic resume
  for a rejected create or treat its receipt as an accepted job.
- **Never call create again to check on a job.** A second create is a second
  paid asset. Poll the ID you already have.
- **Never retry an explicit-mode create whose outcome is unclear.** After a timeout, connection
  loss, or unclear server response, the server may still have accepted it; the
  recovery receipt remains `submission_outcome_unknown`. Tell the user to check
  the Palatial dashboard before submitting anything else. A receipt alone does
  not imply an unclear outcome; a definite start-gate rejection is handled above.
  Automatic creation can recover by replaying identical inputs with the original
  `request_id`; never use a new ID to recover an uncertain automatic submission.
- Confirm with the user before reprocessing, creating a variant, or generating
  a batch of assets from one request.
- A failed asset may have a partial export. Ask first, then pass
  `allow_failed_export: true` and label the result partial or unvalidated.
- `READY` means generation is complete. Inspect `details.media` for each available
  representation; it does not promise every media type. It does not mean the asset behaves correctly
  in the user's simulator. Report generation and validation separately, and do
  not claim a simulator accepted an asset unless the user tested it.

## Picking the source

| The user has | `source` | Required inputs |
| --- | --- | --- |
| Only a description | `text` | No photos; Mad Max may take a `reference_mesh_path` |
| One photo or render | `image` | `image_path` |
| Several angles of one object | `image` | `views` or `image_paths`, within the route limits |
| A product video | `image` | `video_path`, optionally with photos |
| A CAD or mesh file | `cad` | `mesh_path`; `image_path` is optional |
| Photos and 3D files together, or 3D files whose role you must state | `files` | `files`, each 3D file with its `purpose` when it is not obvious |

With `source: files`, say what each 3D file is for: `exact_geometry` keeps its
shape (the CAD build), `shape_reference` makes a GLB, STEP, OBJ, STL or PLY file
a shape guide for a Mad Max build, and `unused` leaves it out. A lone 3D file, or
one that can only be built as-is, defaults to `exact_geometry`. A GLB, STEP, OBJ,
STL or PLY file sent with photos has no default: the
API refuses it with `BUILD_INPUT_PURPOSE_REQUIRED` and lists the purposes each
file may take, so ask the user rather than guessing.

Put real dimensions, materials, articulation, and intended use in
`description`. It is the single most important field, and for `source: image`
it is the only place dimensions can go.

## Picking the generation mode

For new text/image requests, choose `mode` and put its build settings inside
`parameters`. Read `references/parameters.md` for the allowed settings.

- **Diffusion** (`mode: diffusion`) is the best choice for image-accurate,
  visually convincing objects when approximate scale is acceptable. It is
  especially good for organic objects and shapes, and gives control over
  articulation. It takes one photo or 2-4 named views. `parameters.structure`
  chooses `single_object`, `static_parts` (default), or `articulated_parts`.
- **Parametric Low** (`mode: parametric`, `effort: low`, the
  default effort for Parametric) is good for household objects and articulated
  objects, especially simple mechanisms, with control over scale. Detailed
  prompts specifying dimensions, parts and intended motion help guide the
  result. It takes 1-50 photos and authors rigid parts. Choose joints with
  `parameters.articulation` and an authored face budget with `parameters.face_budget`.
- **Mad Max** (`mode: parametric`, `effort: mad_max`) focuses on research and
  reconstruction at the highest quality and generally takes multiple hours to
  complete. Choose it when that reconstruction quality is the priority and the
  task allows the time. It chooses structure, density and appearance itself,
  so omit `parameters` or send `{}`. It takes exactly one engine and at most
  8 photos (7 with a scanned GLB `reference_mesh_path`). `mode: mad_max` is
  accepted shorthand.

A `video_path` works on every image route and requires empty `parameters`:
research settles the build from the clip. MP4/MOV, at most 300 MiB and 60 seconds.
Diffusion and Low accept up to 50 photos beside a video; Mad Max keeps its cap.

Mad Max and video builds accept top-level `product_research`: `on` is the
default; `specs_only` researches specifications without web photos, and `off`
skips web lookup. The latter two require uploaded photos or a video.

CAD uses flat settings and has no `mode`. The MCP exposes neither `shape_model`
nor `texture_model`: mode and effort choose the shape route, and the backend
chooses the painter. All MCP assets are rigid; body_type, auto_scale and
replace_glass are omitted. Prefer collision_quality: auto (or omission) for
Diffusion/Low: the MCP leaves the API override unset, currently using medium.
Mad Max chooses collision proxies itself and takes no collision setting. SDF
is an explicit collision choice, not the ordinary rigid-body default.
The CLI/API client accepts older request files with
`shape_model` and flat build settings when mode is absent.

## Reading the route back

A finished asset reports how it was built as `generationAgent`: `diffusion`,
`parametric`, or `mad_max`. `palatial_get_asset` surfaces this as
`generation_route`, and the full record from `palatial_get_asset_details`
carries the route field and its server-owned progress metadata.

Use that label to select the equivalent create mode. `mad_max` corresponds to
`mode: parametric` with `effort: mad_max`; `parametric` corresponds to Parametric Low.
Read the current request rules before selecting its build settings.

## Writing the rest of the request

New text/image requests should set `source`, `name`, `description`, `mode`,
and `engine`, adding `effort` when selecting Mad Max. Use the route defaults
for settings the user has not specified.

Reach for `references/parameters.md` before setting any other field. It lists
every parameter, its default, which sources accept it, and the cross-field
rules that cause a rejected request. Several parameters look interchangeable
and are not.

`references/recipes.md` has a complete worked request for each source.

`references/troubleshooting.md` covers failed, canceled, and paused jobs,
partial exports, and the difference between reprocessing and creating a variant.

## Reporting back

Give the user the asset ID, the current status, and where any downloaded file
landed. If you set any parameter beyond name, description, and engine, say
which and why. State plainly what you did not verify.

## Scenes

For a complete scene reconstructed from videos, photos or a floor plan, read
`palatial_guide` with `topic: scenes` before calling `palatial_create_scene`.
Use the scene tools to track object orders, answer questions, stop work and
download the accepted scene package. The scene ID also opens the same scene
in the Dashboard Viewer.
