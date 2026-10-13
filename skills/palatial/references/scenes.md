# Scene generation

Scene generation reconstructs a complete scene from photos, videos, floor
plans and instructions. The public API, MCP and Dashboard use the same scene
service, object orders, billing, question and cancellation contracts. The MCP
requires no Dashboard Agent conversation or confirmation card.

## Workflow

The primary scene tools match the four API operations:

1. `palatial_create_scene` creates and starts a scene with one API request. Supply
   a stable UUID `request_id`, authorized `workspace`, instructions and
   `confirm_spend: true` after obtaining authorization for director and object
   charges. Use `source_paths` for named local files or `sources` containing
   `{filename, media_type, url}` for HTTPS photos, videos or floor plans.
   Set `auto_continue: true` to continue checkpoints and continuation questions
   automatically using the original instructions. The default is false.
2. `palatial_get_scene` returns status, progress, object inventory, cumulative
   cost, pending questions, comparison images and available package links.
   Unknown or unsettled cost stays unknown. Poll this same scene ID.
3. `palatial_cancel_scene` stops the director and object builds idempotently.
   Inspect partial failures; completed work remains charged.
4. `palatial_download_scene` downloads the accepted scene package to `output_dir`.
   An optional `version` pins an accepted package; otherwise the current accepted
   version is selected. It verifies the archive digest and saves a receipt.

`palatial_answer_scene` is optional for callers using `auto_continue: false`.
Answer the exact current `input.expected_head`; a stale answer conflicts.
Fault recovery and start retries belong to the service. Do not create a replacement
scene or use a new UUID after uncertainty. List/recover/retry client methods remain
for compatibility, but are no longer advertised as MCP tools.

## Example


```json
{
  "workspace": "0123456789abcdef01234567",
  "request_id": "43292215-7330-489c-83b5-324c3b337e9a",
  "description": "Reconstruct this workshop. Preserve the bench and cabinets at their measured scale.",
  "source_paths": ["/absolute/path/workshop.mp4", "/absolute/path/floor-plan.pdf"],
  "floor_plan": "floor-plan.pdf",
  "confirm_spend": true,
  "auto_continue": true,
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

## Inputs and delivery

Local sources support PNG, JPEG, WebP, PDF, MP4, MOV and WebM. Select at most
32 combined local and URL sources, each at most 1 GB (1,000,000,000 bytes).
Description and answer instructions accept up to 4000 characters. Filenames
must be distinct, 1–128 ASCII characters, start with a letter or digit, and
contain only letters, digits, periods, underscores or hyphens. A floor plan
names an input filename exactly. The provider validates media content.

The client validates all local files before creating anything. Small files use
inline upload in the create-and-start request. Files above the combined 32 MiB inline budget obtain signed
storage upload instructions from that request; the client streams the files without
sending the API key to storage. The service automatically starts when the uploaded
bytes and checksum are verified. No caller-side generate or multipart operation is
required. Replaying the original UUID and unchanged inputs returns the same scene;
changed content conflicts. Deprecated previously uploaded owned source descriptors
remain supported on the compatibility path; use local paths or URLs for new requests.

The same `scene_id` is the Asset ID used by the Dashboard Viewer. Downloads select
accepted delivery packages, preserve existing files and verify ETag, Content-Length
and SHA-256. A downloaded package does not prove simulator acceptance.

The public API uses `POST workspaces/:workspaceId/scene-generations/start`,
`GET scene-generations/:sceneId`, `POST scene-generations/:sceneId/stop` and
`GET scene-generations/:sceneId/download`. API JSON spells the MCP option
`auto_continue` as `autoContinue`. Optional manual answers use `POST .../answer`.
All endpoints share the Dashboard's Nest services and use `x-api-key` authentication.
