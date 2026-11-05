# Scene generation

Scene generation reconstructs a complete scene from photos, videos, floor
plans and instructions. The public API, MCP, CLI and Dashboard use the same
scene service, object orders, billing, question and cancellation contracts.
Scene generation is currently enabled on Dev; configure `PALATIAL_API_URL` to
the authorized Dev external API origin before starting the MCP server.

## Workflow

| Step | MCP tool | CLI | JavaScript |
|---|---|---|---|
| Start | `palatial_create_scene` | `scene-create --request scene.json` | `createScene(input)` |
| Read | `palatial_get_scene` | `scene-get --scene-id ID` | `getScene(sceneId)` |
| Message | `palatial_message_scene` | `scene-message --scene-id ID --text ...` | `messageScene(sceneId, { text, requestId?, confirmSpend?, expectedHead?, regenerateObjects? })` |
| Stop | `palatial_stop_scene` | `scene-stop --scene-id ID` | `cancelScene(sceneId)` |
| Download | `palatial_download_scene` | `scene-download --scene-id ID --output-dir DIR` | `downloadScene(input)` |

1. **Start** creates and starts a scene with one API request. Supply a stable
   UUID `request_id`, authorized `workspace`, instructions and
   `confirm_spend: true` after obtaining authorization for director and object
   charges. Use `source_paths` for named local files or `sources` containing
   `{filename, media_type, url}` for photos, videos or floor plans on public HTTPS hostnames. No credentials, fragments, IP addresses, or loopback, link-local, or metadata hosts.
   Set `auto_continue: true` to continue checkpoints and continuation questions
   automatically using the original instructions. The default is false.
2. **Read** returns status, progress, object inventory, cumulative cost, the
   pending question, comparison images, available package links and
   `next_message`. Unknown or unsettled cost stays unknown. Poll this same
   scene ID; reading never changes or charges a scene.
3. **Message** sends one message; the server decides what it does from the
   scene's state (see below).
4. **Stop** stops the director and object builds idempotently. It is free;
   completed work remains charged. Inspect `cancellation` for partial failures.
   A message never stops a scene.
5. **Download** saves the accepted scene package to `output_dir`. An optional
   `version` pins an accepted package; otherwise the current accepted version
   is selected. It verifies the archive digest and saves a receipt.

Do not create a replacement scene or use a new UUID after uncertainty.

## Messages

Read `next_message` from the scene before sending one:

```json
"next_message": {
  "action": "continue",
  "requires_confirm_spend": true,
  "accepts_text": true,
  "requires_text": false,
  "accepts_regenerate_objects": true,
  "regenerable_objects": ["chair-2"],
  "expected_head": "sha256:...",
  "question": null,
  "reason": null,
  "price_basis": "new_work_actual_cost"
}
```

| `action` | When | `confirm_spend` | What the message does | Result `message.action` |
|---|---|---|---|---|
| `relay` | the scene is running and no Stop was asked | no | text is passed to the scene director; the message itself is free | `relayed` or `queued` |
| `answer` | the scene waits on its question | no | text is the answer, within the original authorization | `answered` |
| `resume` | the scene is parked at a checkpoint that offers a plain recover | no | continues the run; text, when given, is kept as guidance | `resumed` |
| `continue` | the scene ended (delivered, best checkpoint, stopped, held in review) and a continuation is offered | **yes** | continues the whole scene as new paid work; text is its instruction or guidance | `continued` |
| `retry_start` | the start was refused before any run and is retryable | **yes** | retries the original start; text is recorded only | `start_retried` |
| `none` | nothing above applies | - | refused with 409 `scene_not_messageable` and a `reason` | - |

- `confirm_spend: true` is the user's authorization for new paid work. Ask
  before setting it; never set it on the user's behalf. Without it a paid
  message returns 409 `confirm_spend_required` with `next_message` and does
  nothing. Continuing reuses built objects; new planning and object builds
  are billed at actual cost, and the workspace needs a positive balance
  (403 `insufficient_tokens` otherwise).
- A change request on a delivered scene continues the whole scene.
- `text` is 1-4000 characters and required for `relay` and `answer`
  (400 `scene_message_text_required`).
- `expected_head` is optional; pass `next_message.expected_head` to refuse
  the message (409 `scene_head_moved`) if the scene moved on. A relay has no head.
- `regenerate_objects` lists failed or dropped object IDs from
  `next_message.regenerable_objects`; it is accepted only with `continue`.
- Every message has a UUID `request_id`. The client generates one when it is
  omitted and returns it on the receipt and on errors. The same ID and body
  replay the stored receipt; the same ID with a different body is 409
  `request_id_reused`. After 503 `scene_message_unconfirmed` or a lost
  response, replay the same ID and body; a new ID is a new message.
- A running scene can refuse a relay with 409 `scene_guidance_unsupported`,
  `scene_guidance_limit` or `scene_guidance_stopped`.

MCP has no separate answer, recover or retry tools. The JavaScript methods
`answerScene`, `recoverScene` and `retrySceneStart` are deprecated aliases of
`messageScene` and keep working; at a settled scene the server requires
`confirm_spend: true` on them too. `listScenes` remains for compatibility.

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
Description and message text accept up to 4000 characters. Filenames
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
`GET scene-generations/:sceneId`, `POST scene-generations/:sceneId/messages`,
`POST scene-generations/:sceneId/stop` and `GET scene-generations/:sceneId/download`.
API JSON spells the MCP option `auto_continue` as `autoContinue`. The older
`answer`, `recover`, `continue`, `objects/:objectId/regenerate` and
`retry-start` routes are deprecated aliases of `messages`. All endpoints share
the Dashboard's Nest services and use `x-api-key` authentication.
