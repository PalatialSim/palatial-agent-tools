# When something goes wrong

## A create call errored

For `insufficient_tokens` or `insufficient_credits`, report the supplied net
`tokens.balance` and top-up guidance. The shared organization/workspace balance
must be above zero; an estimated whole-job price or recommended balance is not
an admission requirement. Do not start checkout or retry generation automatically.

If a submission times out or its outcome is unclear, it may still have been
accepted. The error carries the path of a local recovery receipt holding the
request ID, name, source, and time.

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
- A failed validation stage does not always mean nothing was produced. Do not
  request a partial export automatically. Ask the user first; after confirmation,
  call `palatial_download_asset` once with
  `allow_failed_export: true`, then label any package partial or unvalidated and
  name the stage that failed.
- Only successfully completed stages are charged; failed stages are not charged.
  Reprocessing uses per-stage completion billing and needs the user's
  confirmation first.
- Never create a replacement asset to find out what happened.

Report the failure reason, the failed stage, the dashboard link, and the
support path. Ask before doing anything that spends more.

## The job was canceled or paused

Canceling stops the work. It does not imply a refund and it does not delete
anything already downloaded.

For `PROCESSING_PAUSED` or `paused` with `pauseReason: insufficient_credits`,
report `billing_guidance`, the shared balance, and the asset ID. Running stages
can complete after the balance reaches zero and leave debt. A payment started
is not yet a posted credit. When credit posts, it offsets debt first; once the
net balance is above zero, the server automatically resumes the same asset.
Use `palatial_get_asset` to observe it and `palatial_get_pipeline_progress` to
inspect the stage. Do not call create, variant, or reprocess as a resume action,
and do not start checkout automatically. Recommended balances of 10 or 20 tokens
are advisory, not required top-up amounts.

For any other pause reason, inspect it with `palatial_get_pipeline_progress`
and report the actual reason rather than assuming it needs a top-up. A negative
balance alone does not mean a running stage is paused.

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

Export itself does not consume tokens, and the client does not automatically
retry a failed download. Tell the user what happened and let them decide.
A first export requires a positive shared net balance. A previous server export
remains downloadable at zero or negative balance, including while a later run
is paused. `export.status: READY` or an existing `export.key` identifies an
available export; let `palatial_download_asset` reach the server to check it.

If the output directory already holds a file for that asset, the client refuses
rather than overwriting. Use a new directory. When a previous download and its
receipt are both intact and the checksum matches, the client reuses the local
file without downloading it again.

## Authentication and access errors

| What you see | What it means |
| --- | --- |
| Not authenticated | No key. The user runs `palatial-agent login` in a terminal, or sets `PALATIAL_API_KEY` in the environment that starts the coding agent. |
| Invalid or expired API key | The key was rejected. The user checks it in the Palatial dashboard. |
| `insufficient_tokens` or `insufficient_credits` | The shared organization/workspace net balance must be above zero. Report the numeric balance when returned. Credit-paused jobs resume on the same asset after enough credit posts to cover debt and leave a positive balance. |
| Access denied or insufficient credits | A legacy response without a specific billing code. The user checks workspace permissions and balance in the dashboard. |
| Asset or workspace not found | Usually a mistyped asset ID, or a key scoped to a different workspace. |
| Request conflicts with asset state | The asset is not in a state that allows this, for example requesting a first export before outputs are ready. |
| Rate limit reached | Wait and retry reads. Do not retry writes automatically. |

Never ask the user to paste a key into the conversation, and never put one in a
tool argument or a command line.

## The tools are missing entirely

The user reruns `palatial-agent setup` and starts a fresh coding-agent session.
An MCP process already running keeps its old version until the client restarts.
