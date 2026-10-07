---
name: palatial
description: Generate simulation-ready 3D assets from text, images, or CAD with the Palatial MCP tools, and choose the right palatial_create_asset parameters. Use when a task needs a 3D asset for Isaac Sim, MuJoCo, or Newton, or when creating, tracking, reprocessing, or downloading a Palatial asset.
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

1. `palatial_create_asset` submits the job and returns immediately with an
   `asset_id`. It does not wait for the asset to be built.
2. Save that `asset_id` in your reply and in any file you are writing. It is the
   only handle to the job.
3. `palatial_get_asset` polls it. Generation takes minutes, not seconds.
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

## Rules that cost the user money when broken

- Generation uses the shared organization/workspace net token balance.
  `palatial_create_asset`, `palatial_create_variant`, and
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
- **Never retry a create whose outcome is unclear.** After a timeout, connection
  loss, or unclear server response, the server may still have accepted it; the
  recovery receipt remains `submission_outcome_unknown`. Tell the user to check
  the Palatial dashboard before submitting anything else. A receipt alone does
  not imply an unclear outcome; a definite start-gate rejection is handled above.
- Confirm with the user before reprocessing, creating a variant, or generating
  a batch of assets from one request.
- A failed asset may have a partial export. Ask first, then pass
  `allow_failed_export: true` and label the result partial or unvalidated.
- `READY` means the outputs exist. It does not mean the asset behaves correctly
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

Put real dimensions, materials, articulation, and intended use in
`description`. It is the single most important field, and for `source: image`
it is the only place dimensions can go.

## Picking the generation mode

For new text/image requests, choose `mode` and put its build settings inside
`parameters`. Read `references/parameters.md` for the allowed settings.

- `mode: diffusion` is fastest and cheapest and suits organic shapes. It takes
  one photo or 2-4 named views. `parameters.structure` chooses `single_object`,
  `static_parts` (default), or `articulated_parts`.
- `mode: parametric`, `effort: low` (default) suits manufactured objects and
  moving parts. It takes 1-50 photos and authors rigid parts. Choose joints with
  `parameters.articulation` and an authored face budget with `parameters.face_budget`.
- `mode: parametric`, `effort: mad_max` researches and authors the product. It
  chooses structure, density and appearance itself, so omit `parameters` or
  send `{}`. It takes exactly one engine and at most 8 photos (7 with a scanned
  GLB `reference_mesh_path`). `mode: mad_max` is accepted shorthand.

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
`mode: parametric` with `effort: mad_max`; `parametric` corresponds to Low.
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
