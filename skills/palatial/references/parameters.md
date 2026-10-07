# palatial_create_asset parameters

MCP create arguments and their refusal rules. Text/image requests require
mode. The MCP builds rigid assets and omits shape_model, texture_model,
body_type, auto_scale and replace_glass. The CLI/API client keeps older flat
request files compatible. Defaults come from the API when omitted.

Set as little as possible. The defaults are chosen to produce a usable asset,
and an omitted field is safer than a guessed one.

## Current generation contract

Check [Using the API](https://docs.palatial.cloud/integrations/api/) for current
rules. `palatial_check_docs` compares the live docs with the last successful
snapshot; read changed pages before using affected settings.

| Field | Values | Default | Sources | Notes |
| --- | --- | --- | --- | --- |
| `mode` | `diffusion`, `parametric`, `mad_max` | required for text/image | `text`, `image` | Preferred for new requests. `mad_max` is shorthand for Parametric at Mad Max effort. CAD has no mode. |
| `parameters` | object with `mesh_quality`, `collision_quality`, `triangle_count`, `mesh_density`, `decimation`, `decimation_mode`, `decimation_target_faces`, `decimation_target_ratio`, `texture_size`, `optimize_textures`, `texture_max_resolution`, `run_simulation`, `newton_solver`, `repair_mesh`, `structure`, `articulation`, `face_budget` | route defaults | `text`, `image` | Only the settings allowed for the chosen route; see below. JSON types stay numbers and booleans, including multipart uploads. |

- **Diffusion:** `structure` (`single_object`, `static_parts`, `articulated_parts`),
  mesh quality/density/triangle controls, decimation, texture generation/delivery,
  collision/physics, rigid solver and mesh repair.
  Defaults: static parts, high quality (medium for one object), medium collision,
  4K textures and strict 100,000-face simplification.
- **Parametric Low:** `articulation` (false), `face_budget` (100,000; allowed
  2,000-200,000), `collision_quality` (medium), `run_simulation` (true),
  `optimize_textures` (true), and `newton_solver`
  (`mujoco` or `style3D`). It authors rigid parts; mesh quality, texture size,
  body type and mesh repair are unsupported settings.
- **Mad Max and every video build:** omit `parameters` or send an empty object.
  Research decides the build settings. Mad Max takes exactly one engine.

With `mode`, top-level legacy build settings are refused
(`CREATE_MODE_FIELD_CONFLICT`). A route-inappropriate setting is refused
(`CREATE_PARAMETERS_INVALID`); `parameters` without `mode` is refused
(`CREATE_MODE_REQUIRED`). Effort on Diffusion or conflicting with the Mad Max
shorthand is refused (`CREATE_EFFORT_INVALID`). `product_research` on a route
without research is refused (`CREATE_PRODUCT_RESEARCH_UNSUPPORTED`).
A refused request sends no generation from this client.

The build fields below use flat names for CAD. With text/image mode, use
the corresponding allowed setting in parameters. Diffusion/Low collision auto
is an MCP alias that omits the API override, currently selecting medium. The
raw API does not yet accept the string auto. Mad Max chooses proxies itself;
it takes no collision setting. SDF is an explicit choice, not the default.
Higher hull quality trades more detail for collision computation; it does not
guarantee better simulator behaviour. Automatic selection does not guarantee
a primitive collider on Diffusion/Low.

## Always required

| Field | Values | Default | Sources | Notes |
| --- | --- | --- | --- | --- |
| `source` | `text`, `image`, `cad` | required | all | Decides which file fields are legal. See the source rules below. |
| `name` | 4 to 50 characters | required | all | Letters, digits, spaces, underscores, hyphens, periods. |
| `description` | 1 to 2000 characters | required | all | What to build, including dimensions, materials, articulation, and intended use. For `source: image` this is the only place size and orientation can be stated. |

## Common

| Field | Values | Default | Sources | Notes |
| --- | --- | --- | --- | --- |
| `engine` | 1 to 3 of `isaac_sim`, `mujoco`, `newton` | `["isaac_sim"]` | all | Simulator profiles to build for. Each added engine is more work, so ask rather than requesting all three. |
| `workspace` | workspace ID | the API key's workspace | all | Only needed when the key spans several workspaces. |

## Input files

| Field | Values | Default | Sources | Notes |
| --- | --- | --- | --- | --- |
| `image_path` | one PNG, JPEG, or WebP path | none | `image`, `cad` | Required for a single-image request. Optional for CAD; provide it when asking to generate textures from a reference. |
| `image_paths` | 1 to 50 PNG, JPEG, or WebP paths | none | `image` | Parametric Low or any video build. Mad Max: at most 8 photos, or 7 with a reference mesh; total includes named views and image_path. |
| `video_path` | one MP4 or MOV path | none | `image` | Up to 300 MiB and 60 seconds; may accompany photos. Every video route requires empty parameters. Server validates duration and video bytes. |
| `reference_mesh_path` | scanned GLB path | none | `text`, `image` | Mad Max only; uploaded as reference_mesh. Counts as one of its 8 inputs. |
| `views` | object with `front`, `left`, `back`, `right` | none | `image` | Named angles of one object. Diffusion without video needs 2-4; Parametric or video builds can mix these with uploaded photos. |
| `reconstruct` | boolean | ignored | `image` | Legacy API field. The current Queue ignores it: one image does not trigger synthetic view generation, and supplied views are processed directly. Omit this field. The client rejects it with `mad_max` effort. |
| `mesh_path` | path to the mesh file | none | `cad` | Required for CAD. |
| `datasheet_path` | path to a PDF | none | `cad` | Optional specification sheet. |

Each local input must be a nonempty regular file of at most 256 MiB (300 MiB for video). References must be
PNG, JPEG, or WebP; datasheets must be PDF.

## What to build

| Field | Values | Default | Sources | Notes |
| --- | --- | --- | --- | --- |
| `create_articulation` | boolean | `false` | all | Create joints for moving parts such as doors, drawers, or wheels. Turn on only when the user needs the object to move. |
| `enable_parts_segmentation` | boolean | `true` | all | Split the object into separate rigid parts. Set `false` for one solid rigid mesh. |
| `run_simulation` | boolean | `true` | all | Run physics validation after the build. |
| `collision_quality` | `auto`, `low`, `medium`, `high`, `sdf` | `auto` (currently medium) | all | Prefer auto or omission. medium/high use authored hulls; low delegates convex decomposition to the target simulator; sdf requests signed-distance fields. Mad Max accepts no override. |
| `mesh_quality` | `low`, `medium`, `high` | `high`; `medium` when parts segmentation is off and articulation is not requested | `text`, `image` | Generation quality. **Rejected for CAD**, which starts from a mesh the user supplied. |
| `repair_mesh` | boolean | `true` | all | Close holes and fix bad geometry after generation. |

## How the object behaves

| Field | Values | Default | Sources | Notes |
| --- | --- | --- | --- | --- |
| `newton_solver` | `mujoco`, `style3D` | `mujoco` | all | Read only when `engine` includes `newton`. |

All MCP assets are rigid. Joints still connect rigid parts: use Diffusion
structure: articulated_parts or Parametric Low articulation: true.

## Route and research

| Field | Values | Default | Sources | Notes |
| --- | --- | --- | --- | --- |
| `effort` | `low`, `mad_max` | `low` when parametric | `text`, `image` | Requires `mode: parametric` . `low` runs the parametric pipeline. `mad_max` researches the described product and authors the model; it costs more and takes longer. **Rejected for CAD.** |
| `product_research` | `on`, `specs_only`, `off` | `on` | `text`, `image` | How much research Mad Max or any video build does. Narrowed modes require photos or video. `on` researches the real product on the web, its pages and its product photos. `specs_only` reads the web for identity and specifications but uses no web images, so the model is built only from your images. `off` looks nothing up. Use `specs_only` or `off` when your own photos show the exact unit and web photos of similar products could mislead the build. |
| `apply_textures` | boolean | `true` with a CAD reference image, `false` without one | `cad` | Generate textures from the reference image. `true` requires `image_path`. When it is off, there is no texture generation. |

## Texture output

These two look interchangeable and are not. They act at different stages.

| Field | Values | Default | Sources | Notes |
| --- | --- | --- | --- | --- |
| `texture_size` | `2048`, `4096`, `8192` | `4096` | all | The texture size requested from the generator. |
| `optimize_textures` | boolean | `true` | all | Downscale oversized maps and optimize encoding afterwards. Never upscales a smaller map. |
| `texture_max_resolution` | `512`, `1024`, `2048`, `4096`, `8192` | `4096` | all | The long-edge cap applied during that optimization pass, so it only takes effect while `optimize_textures` is on. |

To ask for smaller textures end to end, lower `texture_size`. To keep
generation quality but cap what ships in the export, lower
`texture_max_resolution`.

## Mesh budget and decimation

This is the group that most often produces a rejected request. Read it before
setting any of these fields.

**The default already decimates.** When a `text` or `image` request specifies
none of `decimation`, `decimation_mode`, `decimation_target_faces` or
`decimation_target_ratio`, the API applies strict decimation with a 100,000
face target. CAD does not decimate by default.

| Field | Values | Default | Sources | Notes |
| --- | --- | --- | --- | --- |
| `decimation` | boolean | see above | all | Pass `false` to turn decimation off entirely. Passing `true` selects the legacy path, where `triangle_count` decides the target. |
| `decimation_mode` | `auto`, `strict` | see above | all | `auto` is quality-driven adaptive reduction and accepts no target. `strict` enforces a number and requires exactly one target field. |
| `decimation_target_faces` | integer, 4 to 10,000,000 | none | all | Strict mode only. Mutually exclusive with the ratio. |
| `decimation_target_ratio` | 0.001 to 0.999 | none | all | Strict mode only. The fraction of source faces to keep. Mutually exclusive with the face target. |
| `triangle_count` | `minimal`, `low`, `medium`, `high`, `x_high`, `auto` | `auto` | all | Legacy preset, read only when `decimation_mode` is absent. A fixed value switches on strict decimation with that preset's face target: `minimal` 20,000, `low` 50,000, `medium` 100,000, `high` 200,000, `x_high` 500,000. |
| `mesh_density` | `low`, `medium`, `high` | `medium` | all | Read **only while `triangle_count` is `auto`**. Setting a fixed triangle count silently makes this field irrelevant. |

Decide it this way:

- No opinion on mesh size: set nothing. You get strict 100,000 faces on
  generated sources.
- A hard polygon budget: `decimation_mode: "strict"` plus exactly one of
  `decimation_target_faces` or `decimation_target_ratio`.
- Let quality decide: `decimation_mode: "auto"` and no target.
- Keep the full-resolution mesh: `decimation: false` and no target.

Do not mix the legacy fields with the explicit ones in one request.

## Reusing what a CAD file already has

By default a CAD request generates appearance when a reference image is supplied
and keeps authored parts. With no reference image, texture generation is off.
These four flags say what to keep or regenerate explicitly.

| Field | Values | Default | Sources | Notes |
| --- | --- | --- | --- | --- |
| `regenerate_parts` | boolean | `false` | `cad` | Split the supplied mesh into parts again rather than keeping the parts it already has. |
| `keep_existing_textures` | boolean | `false` | `cad` | Keep the textures the mesh already has. This turns texture generation off. |
| `keep_existing_shape` | boolean | `false` | `cad` | Keep the shape and parts the mesh already has. |
| `physics_validation_only` | boolean | `false` | `cad` | Both of the above at once: skip appearance and parts, run collision, physics and validation. |

Use `physics_validation_only` when the user says the model is already right and
they only want it simulation-ready. Use the two narrower flags when only one
half should be kept.

**Keeping the appearance needs a format that can carry one.** A GLB can contain
bound texture images; the API inspects the uploaded bytes when texture generation
is off. If the GLB lacks a usable embedded texture, a request to preserve its
appearance with a reference image is rejected. Other direct mesh uploads
(OBJ, GLTF, STL, PLY, FBX) cannot prove their external texture sidecars from the
single uploaded file. With a reference image, their appearance-preservation
requests are rejected. Without a reference image, these formats may remain
untextured by leaving `apply_textures` off, but explicit keep-existing flags
still need appearance evidence. USD, STEP, and IGES may keep their authored
appearance.

## Scale and orientation

| Field | Values | Default | Sources | Notes |
| --- | --- | --- | --- | --- |
| `units` | `m`, `cm`, `mm`, `inch`, `feet` | `m` for text; format-dependent for CAD | `text`, `cad` | One scale option for OBJ, GLB, GLTF, STL, PLY, and FBX; alternatively provide `meters_per_unit`. Omit for STEP/IGES and USD-family files. |
| `meters_per_unit` | positive finite number | none | `cad` | Exact scale for a direct mesh, as an alternative to `units`; if both are set they must agree. Omit for STEP/IGES and USD-family files. |
| `up_direction` | `x`, `y`, `z` | `y` for text; format-dependent for CAD | `text`, `cad` | Required for OBJ, GLB, GLTF, STL, PLY, FBX, STEP, and IGES. Omit for USD-family files. |

CAD source-frame rules come from the file format:

- OBJ, GLB, GLTF, STL, PLY, and FBX require `up_direction` plus `units` or
  `meters_per_unit`.
- STEP, STP, IGES, and IGS require `up_direction`; their converted scale is
  canonical, so `units` is rejected.
- USD, USDA, USDC, and USDZ use authored stage metadata, so both fields are
  rejected.
- JT and SLDPRT are not supported by this public client.

**Both are rejected for `source: image`.** A photo carries no units, so state
the dimensions and orientation in `description` instead.

## Rules that reject a request

The client checks these before spending anything, and returns an error that
names the rule.

- `text` accepts no photos/video; Mad Max accepts a GLB reference mesh. It rejects `apply_textures`.
- `image` requires photos or a video. Pure Diffusion uses one image_path or 2-4 named views; Parametric or video builds can mix photo inputs within the route cap.
- Diffusion without a video needs 2-4 named views. Parametric and video builds can mix named views and file photos.
- `image_paths` requires Parametric or a video.
- `image` rejects `mesh_path`, `datasheet_path`, `units`, `meters_per_unit`, `up_direction`, and
  `apply_textures`.
- `cad` requires `mesh_path`, accepts an optional `image_path`, and rejects
  `image_paths`, `views`, `reconstruct`, `mesh_quality`, `shape_model`, and `effort`. Source-frame fields
  then follow the file-format rules above.
- `effort` requires Parametric mode on text or image requests.
- `product_research: specs_only` or `off` requires Mad Max or a video, with uploaded photos or video.
- The MCP accepts no shape_model or texture_model. Select mode and effort.
- The legacy `reconstruct` field is ignored by the current Queue. The client
  rejects it with `effort: mad_max`; omit it on all new requests.
- `apply_textures: true` on CAD requires `image_path`.
- Strict decimation requires exactly one target. Any other mode accepts none.
- The four CAD reuse flags are rejected for `text` and `image`.
- `keep_existing_shape` and `physics_validation_only` are rejected alongside
  `regenerate_parts: true`, because they ask for opposite things.
- `keep_existing_textures` and `physics_validation_only` are rejected alongside
  `apply_textures: true`, for the same reason.
- body_type, auto_scale, replace_glass, collision_quality: x_high and
  newton_solver: vbd are outside the MCP surface; older CLI files stay compatible.
- OBJ, GLTF, STL, PLY, and FBX reject explicit requests to keep authored
  appearance. With a reference image, they also reject `apply_textures: false`.
  GLB is accepted for inspection; the API may reject it if no bound embedded
  texture survives the upload.
