# Scene generation

Scene generation reconstructs a complete scene from photos, videos, floor
plans and instructions. The public API, MCP and Dashboard use the same scene
service, object orders, billing, question and cancellation contracts. The MCP
requires no Dashboard Agent conversation or confirmation card.

## Workflow

1. Read this topic and run `palatial_doctor` to check the configured API key.
2. Obtain explicit authorization for director and object charges. Set
   `confirm_spend: true` only when that authorization exists. This is not a
   dollar budget cap: the server does not support a maximum-USD request.
3. Choose one UUID `request_id` and preserve it for the entire request. Call
   `palatial_create_scene` with that ID, the authorized `workspace`, a useful
   `description`, and `source_paths` naming only the files to upload.
4. Save the returned `scene_id`. Poll `palatial_get_scene` for status, outcome,
   object states, cost, token charges, cancellation and current input.
5. When `input` contains a question, answer with `palatial_answer_scene`, its
   exact `input.expected_head`, and `instruction`. Reread on a stale-head
   conflict. Answering continues the original authorized scene.
6. When `download` contains an accepted `version`, call
   `palatial_download_scene` with that version and the chosen `output_dir`.
   Keep the local archive and its SHA-256 receipt. Delivery is not proof of
   simulator acceptance.

`palatial_list_scenes` lists a workspace's scenes. Pass `next_cursor` as
`before` to continue. `palatial_cancel_scene` stops the director and object
builds. It is idempotent; inspect and report partial failures or unconfirmed
operations in `cancellation`. Completed work remains charged. A stop request
alone does not prove that every child stopped.

## Recovery actions

Read `actions` from the current scene before attempting recovery. A failed
status alone does not prove a retry is safe. When the user asks to recover an
existing native checkpoint, call `palatial_recover_scene` with `scene_id` and
the exact `input.expected_head`, even when `input.question` is null. If no
input head is available, report recovery unavailable; do not guess a head.
The server validates the head and
recoverability; continuation may use the existing authorized scene charges.

`palatial_retry_scene_start` retries only the frozen confirmed start on the
same scene. It requires explicit user authorization in `confirm_spend: true`
and server proof that no native execution occurred. If a recovery or retry is
refused, report the gate error and read the current scene state. Never invent
an available checkpoint, replace the scene, or promise that retry is safe
before the server admits it.

## Request example

```json
{
  "workspace": "0123456789abcdef01234567",
  "request_id": "43292215-7330-489c-83b5-324c3b337e9a",
  "description": "Reconstruct this workshop. Preserve the bench and cabinets at their measured scale.",
  "source_paths": ["/absolute/path/workshop.mp4", "/absolute/path/floor-plan.pdf"],
  "floor_plan": "floor-plan.pdf",
  "confirm_spend": true,
  "options": {
    "max_object_builds": 8,
    "allowed_routes": ["diffusion", "parametric"],
    "max_child_attempts": 2,
    "child_intent": {
      "schema": "palatial.scene-child-intent.v1",
      "bodyType": "rigid_bodies",
      "objectBehavior": "static_parts",
      "packageTarget": "IsaacSim",
      "runSimulation": true,
      "provenance": {
        "bodyType": "approved_default",
        "objectBehavior": "user_selected",
        "packageTarget": "user_selected",
        "runSimulation": "user_selected"
      }
    }
  }
}
```

Omit `options` to retain the shared Dashboard defaults. `child_intent` is the
same closed contract the Dashboard uses: rigid bodies, `single_object`,
`static_parts` or `articulated_parts`, simulator target `IsaacSim`, `Newton`
or `MuJoCo`, physics validation, and provenance for every choice. Do not claim
that defaults were selected by the user. `approved_default` means the user
approved the default; use `user_stated` for a preference they expressed and
`user_selected` for an explicit choice. Do not invent unsupported settings.
Mad Max currently supports only `objectBehavior: articulated_parts`; do not
include `mad_max` in `allowed_routes` with `single_object` or `static_parts`.

`object_build_mode: mock_mad_max` is a Dev acceptance option. It replaces the
object provider at its boundary while preserving the normal scene orders,
callbacks and delivery. It does not make the scene director free. When
setting an explicit `child_intent` in this sample mode, use
`objectBehavior: articulated_parts` and `runSimulation: false`, and include
`mad_max` in `allowed_routes`. The normal example above uses real Diffusion
and Parametric object builds and is not a mock-mode request.

## Inputs and recovery

Local sources support PNG, JPEG, WebP, PDF, MP4, MOV and WebM. Select at most
32 sources in total across `source_paths` and `sources`; each source must be
at most 1 GB (1,000,000,000 bytes). The provider validates media content.
Description and answer instructions accept up to 4000 characters. Files above
32 MiB use resumable multipart uploads with parts at most 16 MiB. Source
filenames must be 1-128 characters, start with a letter or digit, and contain
only letters, digits, periods, underscores or hyphens. A floor plan must name an input filename exactly. Inputs must have
distinct filenames. `sources` can reference complete uploaded descriptors
owned by this same scene; arbitrary external URLs and another scene's source
keys are not accepted.

The client checks every local file before creating the draft. If upload or
start fails after creation, the tool error retains the `scene_id` and
`request_id`. Inspect the scene first. Reusing the original UUID and inputs
recovers the same draft or returns the original start; changing description,
options or source content for that UUID conflicts. Never replace the UUID to
retry an uncertain outcome, and never create a new scene to check progress.
No mutation is retried automatically. Multipart upload sessions retain
confirmed parts for an explicit retry.

Report director cost and object cost separately. Keep unknown or incomplete
costs visibly unknown; do not turn a missing value into zero or claim the
reported subtotal is the final bill. Poll the same scene when work is pending.
The same `scene_id` is the Asset ID used by the Dashboard Viewer. Downloads
select an accepted delivery version and preserve existing local files; they
do not create a new export or silently download an unaccepted partial scene.
The version is the package SHA-256 digest. The client verifies the quoted
ETag, Content-Length and downloaded SHA-256 before writing a receipt, and
verifies the version digest again before reusing a cached archive.
