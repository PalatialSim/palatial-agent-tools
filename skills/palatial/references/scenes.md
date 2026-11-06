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
  "requires_text": true,
  "accepts_regenerate_objects": true,
  "regenerable_objects": ["chair-2"],
  "expected_head": "sha256:...",
  "question": null,
  "reason": null,
  "price_basis": "new_work_actual_cost"
}
```

The server decides from the scene's state, never from the words, in this order:

| `action` | When | `confirm_spend` | What the message does | Result `message.action` |
|---|---|---|---|---|
| `retry_start` | the start was refused before any run and can be retried | **yes** | retries the original start; takes no text (`accepts_text: false`) | `start_retried` |
| `answer` | the scene waits on its question | no | text (required) is the answer, within the original authorization | `answered` |
| `resume` | the scene is parked at a checkpoint that takes no answer | no | the run continues; text, when given, is passed to its director | `resumed` |
| `relay` | the scene is running, or between director sessions, and no Stop was asked | no | text (required) is passed to the director; the message itself is free | `relayed`, or `queued` until the director can take it (`guidance_status: not_running`: the run ended first; the text is kept and passed on only if the scene continues) |
| `continue` | the scene ended (delivered, best checkpoint, stopped, held in review) and can be continued | **yes** | continues the whole scene as new paid work; where the ending takes an answer (`requires_text: true`, as for most delivered scenes) text is required and is its instruction, otherwise text is optional and is passed to the continued director | `continued` |
| `none` | nothing above applies | - | 409 `scene_not_messageable` with `reason` (403 `insufficient_tokens` with `reason: scene_message_insufficient_tokens` when the balance is the reason; nothing is recorded or started, so top up and send the message again) | - |

After the action is decided the server checks, in order: an `expected_head`
where the action takes none (409 `scene_head_not_applicable`), a stale
`expected_head` (409 `scene_head_moved`, with the current `expected_head`),
required text (400 `scene_message_text_required`), text the action does not
take (400 `scene_message_text_not_accepted`), `regenerate_objects`
(409 `scene_object_regeneration_unavailable`) and spend consent
(409 `confirm_spend_required`). Each of these refusals, and
`scene_not_messageable`, carries the current `next_message`. Each refusal does
nothing.

- `confirm_spend: true` is the user's authorization for new paid work. Ask
  before setting it; never set it on the user's behalf. Continuing reuses
  built objects; new planning settles at actual cost when the run ends, new
  object builds charge as their steps complete, there is no up-front quote,
  and the workspace needs a positive balance.
- `price_basis` is `none` (relay), `within_original_authorization` (answer,
  resume) or `new_work_actual_cost` (continue, retry_start). A relay that
  wakes a waiting director bills that director turn under the run's original
  limits.
- A change request on a delivered scene continues the whole scene; the
  Dashboard's priced object edits are not part of the public API.
- `text` is 1-4000 characters.
- `expected_head` is optional; pass `next_message.expected_head` to refuse
  the message if the scene moved on. A relay and a start retry have no head
  (`next_message.expected_head` is null); omit it then, because any value is
  refused with `scene_head_not_applicable`.
- `regenerate_objects` lists IDs from `next_message.regenerable_objects`
  (failed or withdrawn objects). It applies only to `continue`, so it always
  needs `confirm_spend: true`; the client refuses it without consent.
- The receipt is `{ scene_id, message, scene }`. `message` has `request_id`,
  `action`, `expected_head`, `instruction_applied`, `guidance_status`
  (`relayed`, `stored`, `not_running`, `unsupported`, `limit`, `stopped` or
  `unavailable` for text passed to the director, else null),
  `regenerate_objects`, `price_basis`, `replayed` and `at`. Each message also
  appears in the Dashboard scene conversation.
- `next_message.reason` for `none` is one of `not_started`, `stopping`,
  `automatic_continuation`, `spending_limit`, `scene_edit_running`,
  `already_running`, `recovery_unavailable`, `status_unavailable` or
  `insufficient_tokens`.
- Every message has a UUID `request_id`. The client generates one when it is
  omitted and returns it on the receipt and on errors. The same ID and body
  return the stored receipt (`replayed: true`); the same ID with a different
  body is 409 `request_id_reused`. A refusal records nothing, so a corrected
  request may reuse the ID. After 503 `scene_message_unconfirmed` or a lost
  response, send the same ID and body again; it completes as first decided.
  A new ID is a new message.
- A running scene can refuse a relay with 409 `scene_guidance_unsupported`,
  `scene_guidance_limit` or `scene_guidance_stopped`; nothing is kept.

### Deprecated routes

| Route | Same as | Consent |
|---|---|---|
| `answer` (`answerScene`) | `answer`, or `continue` with text | `confirm_spend: true` when it continues a scene that ended |
| `recover` (`recoverScene`) | `resume`, or `continue` without text | same as answer |
| `objects/:objectId/regenerate` | `continue` with `regenerate_objects: [objectId]` | always `confirm_spend: true` |
| `continue` | `messages` with `confirm_spend: true` | always; 409 `scene_not_continuable` while running |
| `retry-start` (`retrySceneStart`) | `retry_start` | always |

MCP has no separate answer, recover or retry tools. The JavaScript methods
`answerScene`, `recoverScene` and `retrySceneStart` are deprecated aliases of
`messageScene` and keep working. `listScenes` remains for compatibility.

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
