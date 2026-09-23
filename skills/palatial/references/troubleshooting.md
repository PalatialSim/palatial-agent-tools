# When something goes wrong

## A create call errored

The submission may still have been accepted. The error carries the path of a
local recovery receipt holding the request ID, name, source, and time.

Do not submit again. Tell the user to open the Palatial dashboard and check
whether the asset exists, and give them the receipt path. The receipt is
evidence for a human, not server-side idempotency, so nothing about it makes a
retry safe.

## The job failed

`palatial_get_asset` reports `PROCESSING_FAILED` and includes
`failure_guidance` with the failed stage.

- Keep the top-level `asset_id` from the response as the canonical ID. Do not
  substitute a nested `details.id` unless the API calls it the asset ID.
- Stop polling. A terminal failure does not become ready later.
- A failed validation stage does not always mean nothing was produced. A partial
  export still uses export credits, so do not request one automatically. Ask the
  user first; after confirmation, call `palatial_download_asset` once with
  `allow_failed_export: true`, then label any package partial or unvalidated and
  name the stage that failed.
- Charges for failed stages are refunded. Reprocessing charges only for the
  remaining stages, and needs the user's confirmation first.
- Never create a replacement asset to find out what happened.

Report the failure reason, the failed stage, the dashboard link, and the
support path. Ask before doing anything that spends more.

## The job was canceled or paused

Canceling stops the work. It does not imply a refund and it does not delete
anything already downloaded. A paused job is waiting on something; inspect it
with `palatial_get_pipeline_progress` and show the user the stage rather than
guessing at a cause.

## The user wants another asset built the same way

Read `generation_route` from `palatial_get_asset` (or `generationAgent` from
the full record). `diffusion` and `parametric` map straight to `shape_model`.
`mad_max` maps to `shape_model: parametric` plus `effort: mad_max`. Do not send
the record's `parameters` block back as a create request: it contains
server-owned progress fields (`madMaxBuild`, `madMaxBuildHistory`,
`generationActualCost`) that the API rejects or ignores, and a `shape_model` of
`mad_max` is refused by this client.

## The user wants a change to a finished asset

Two different tools, and the difference matters.

| | `palatial_create_variant` | `palatial_reprocess_asset` |
| --- | --- | --- |
| Produces | A new independent asset with its own ID | A new run on the same asset |
| Source asset | Preserved | Preserved with `destination: "variant"`, **replaced** with the default `overwrite` |
| Takes | `feedback` describing the change | A pipeline stage to restart `from` |
| Needs | The workspace `asset:variant-create` capability | Nothing extra |

Use a variant when the user wants a different version and wants to keep the
original. Use reprocess when a specific stage needs rerunning. Confirm before
either, and say out loud when `overwrite` will replace existing outputs.

## The download failed

An export may already have been authorized and charged. The client does not
automatically retry it. Tell the user what happened and let them decide.

If the output directory already holds a file for that asset, the client refuses
rather than overwriting. Use a new directory. When a previous download and its
receipt are both intact and the checksum matches, the client reuses the local
file and does not pay for a second export.

## Authentication and access errors

| What you see | What it means |
| --- | --- |
| Not authenticated | No key. The user runs `palatial-agent login` in a terminal, or sets `PALATIAL_API_KEY` in the environment that starts the coding agent. |
| Invalid or expired API key | The key was rejected. The user checks it in the Palatial dashboard. |
| Access denied or insufficient credits | Workspace permissions or credits. The user checks both in the dashboard. |
| Asset or workspace not found | Usually a mistyped asset ID, or a key scoped to a different workspace. |
| Request conflicts with asset state | The asset is not in a state that allows this, for example exporting before it is ready. |
| Rate limit reached | Wait and retry reads. Do not retry writes automatically. |

Never ask the user to paste a key into the conversation, and never put one in a
tool argument or a command line.

## The tools are missing entirely

The user reruns `palatial-agent setup` and starts a fresh coding-agent session.
An MCP process already running keeps its old version until the client restarts.
