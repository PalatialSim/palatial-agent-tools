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

## The one workflow

1. `palatial_create_asset` submits the job and returns immediately with an
   `asset_id`. It does not wait for the asset to be built.
2. Save that `asset_id` in your reply and in any file you are writing. It is the
   only handle to the job.
3. `palatial_get_asset` polls it. Generation takes minutes, not seconds.
4. When status is `READY`, `palatial_download_asset` saves the export ZIP and a
   SHA-256 receipt into a directory the user chose. An existing export also
   remains downloadable while a later run is paused.

For several assets at once, poll with `palatial_batch_get_statuses` instead of
one call per asset. For a stuck job, `palatial_get_pipeline_progress` shows
which stage it is on.

## Rules that cost the user money when broken

- Generation uses the shared organization/workspace net token balance.
  `palatial_create_asset`, `palatial_create_variant`, and
  `palatial_reprocess_asset` charge only for successfully completed stages.
  Reads and export itself do not consume tokens.
- A net balance **above zero** admits generation; the estimated total is not
  prepaid. A `low_recommended_balance` warning recommending 10 or 20 tokens is
  advisory. Report the warning and proceed with an authorized generation.
- At zero or negative balance, new jobs are blocked and next stages wait. Already running
  stages finish and can leave debt. For `insufficient_credits`, show
  `billing_guidance` and keep polling the same asset ID. Posted credit covers
  debt first; once the net balance is positive, processing resumes automatically.
  Do not start checkout, reprocess, or create a replacement to resume it.
- A first export requires a positive net balance. An existing server export
  remains downloadable at zero or negative balance. Let the server check
  eligibility; do not block a requested download from a balance snapshot.
- Historical prepaid attempts keep their original admission requirement. An
  `insufficient_tokens` error without postpaid billing metadata can include
  `tokens.required` and `tokens.shortfall` even when the balance is positive.
  Follow its `billing_guidance`; do not promise automatic resume for that error.
- **Never call create again to check on a job.** A second create is a second
  paid asset. Poll the ID you already have.
- **Never retry a create whose outcome is unclear.** If a create errors with a
  recovery receipt, the server may still have accepted it. Tell the user to
  check the Palatial dashboard before submitting anything else.
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
| Only a description | `text` | No files at all |
| One photo or render | `image` | `image_path` |
| Several angles of one object | `image` | `views` (2 to 4 named views) or `image_paths` |
| A CAD or mesh file | `cad` | `mesh_path`; `image_path` is optional |

Put real dimensions, materials, articulation, and intended use in
`description`. It is the single most important field, and for `source: image`
it is the only place dimensions can go.

## Picking the shape model

`shape_model` applies to `text` and `image` only. CAD rejects it.

- `auto` (default) lets Palatial select a supported route. Use it unless the
  user has a specific shape-model requirement.
- `diffusion` is faster and cheaper and handles organic shapes better. Takes
  one image, or up to four named views.
- `parametric` is more controllable and better for articulated objects. It is
  the only model that accepts `image_paths`, which takes 2 to 50 photos of the
  same object.

For `shape_model: parametric`, `effort: low` uses the parametric pipeline.
`medium` and `mad_max` research the described product and author the model;
they cost more and take longer. They work with text and image inputs, not CAD.

## Reading the route back

A finished asset reports how it was built as `generationAgent`: `diffusion`,
`parametric`, or `mad_max`. `palatial_get_asset` surfaces this as
`generation_route`, and the full record from `palatial_get_asset_details`
carries the field and any `madMaxBuild` progress block.

That label is read-only. It is not a `shape_model` value, and copying it into a
new request is refused: `mad_max` is requested with `shape_model: parametric`
and `effort: mad_max`. To rebuild "the same way", read `generation_route` and
translate it, do not paste the record's parameters into a create.

## Writing the rest of the request

Most requests should set `source`, `name`, `description`, `engine`, and nothing
else. The server defaults are deliberate, and a guessed value is worse than an
omitted one.

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
