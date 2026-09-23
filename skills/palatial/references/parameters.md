# palatial_create_asset parameters

Every field accepted by `palatial_create_asset`, what it does, and when it is
rejected. Defaults are what the Palatial API applies when the field is omitted.

Set as little as possible. The defaults are chosen to produce a usable asset,
and an omitted field is safer than a guessed one.

## Always required

| Field | Values | Default | Sources | Notes |
| --- | --- | --- | --- | --- |
| `source` | `text`, `image`, `cad` | required | all | Decides which file fields are legal. See the source rules below. |
| `name` | 4 to 50 characters | required | all | Letters, digits, spaces, underscores, hyphens, periods. |
| `description` | 1 to 500 characters | required | all | What to build, including dimensions, materials, articulation, and intended use. For `source: image` this is the only place size and orientation can be stated. |

## Common

| Field | Values | Default | Sources | Notes |
| --- | --- | --- | --- | --- |
| `engine` | 1 to 3 of `isaac_sim`, `mujoco`, `newton` | `["isaac_sim"]` | all | Simulator profiles to build for. Each added engine is more work, so ask rather than requesting all three. |
| `workspace` | workspace ID | the API key's workspace | all | Only needed when the key spans several workspaces. |

## Input files

| Field | Values | Default | Sources | Notes |
| --- | --- | --- | --- | --- |
| `image_path` | one PNG, JPEG, or WebP path | none | `image`, `cad` | Required for a single-image request. Optional for CAD; provide it when asking to generate textures from a reference. |
| `image_paths` | 2 to 50 PNG, JPEG, or WebP paths | none | `image` | Photos of one object. Accepted **only** with `shape_model: parametric`. |
| `views` | object with `front`, `left`, `back`, `right` | none | `image` | Named angles of one object. Give at least 2. `auto` and `diffusion` accept at most 4. |
| `reconstruct` | boolean | ignored | `image` | Legacy API field. The current Queue ignores it: one image does not trigger synthetic view generation, and supplied views are processed directly. Omit this field. The client rejects it with `medium` or `mad_max` effort. |
| `mesh_path` | path to the mesh file | none | `cad` | Required for CAD. |
| `datasheet_path` | path to a PDF | none | `cad` | Optional specification sheet. |

Each local input must be a regular file of at most 256 MiB. References must be
PNG, JPEG, or WebP; datasheets must be PDF.

## What to build

| Field | Values | Default | Sources | Notes |
| --- | --- | --- | --- | --- |
| `create_articulation` | boolean | `false` | all | Create joints for moving parts such as doors, drawers, or wheels. Turn on only when the user needs the object to move. |
| `enable_parts_segmentation` | boolean | `true` | all | Split the object into separate rigid parts. Set `false` for one solid rigid mesh. |
| `run_simulation` | boolean | `true` | all | Run physics validation after the build. |
| `collision_quality` | `low`, `medium`, `high`, `x_high`, `sdf` | `medium` for ordinary rigid assets | all | Collision geometry fidelity. Soft-body assets use `sdf`. |
| `mesh_quality` | `low`, `medium`, `high` | `high`; `medium` when parts segmentation is off and articulation is not requested | `text`, `image` | Generation quality. **Rejected for CAD**, which starts from a mesh the user supplied. |
| `repair_mesh` | boolean | `true` | all | Close holes and fix bad geometry after generation. |
| `replace_glass` | boolean | `false` | all | Rebuild transparent or translucent parts as real glass. Set it for clear plastic, acrylic, resin, crystal, and lenses too, not only for things called glass. |
| `auto_scale` | boolean | `true` | all | Scale the finished asset to the real-world size stated in `description`. |

## How the object behaves

| Field | Values | Default | Sources | Notes |
| --- | --- | --- | --- | --- |
| `body_type` | `rigid_bodies`, `soft_bodies`, `mixed_bodies` | `rigid_bodies` | all | What the object is made to behave like. `rigid_bodies` is a solid object. `soft_bodies` deforms: cloth, garments, cable, rope. `mixed_bodies` has both in one asset. |
| `newton_solver` | `mujoco`, `style3D`, `vbd` | `vbd` for soft bodies, `mujoco` for rigid | all | Read only when `engine` includes `newton`. |

Soft bodies simulate in Newton, so a soft-body request should include `newton`
in `engine`. The solver is tied to the body type: soft bodies accept only
`vbd`, and rigid bodies accept `mujoco` or `style3D`. The API silently swaps a
solver the body type cannot use, so this client refuses the contradictory pair
instead and names the value that body type accepts.

Body type is independent of articulation. A rigid object can still have joints:
a swivel chair with rolling wheels is `rigid_bodies` with
`create_articulation: true`.

## Shape and texture models

| Field | Values | Default | Sources | Notes |
| --- | --- | --- | --- | --- |
| `shape_model` | `auto`, `diffusion`, `parametric` | `auto` | `text`, `image` | `auto` lets Palatial select a supported route. `diffusion` is faster, cheaper, and better at organic shapes; it takes one image or up to 4 named views. `parametric` is more controllable and better for articulation; it is the only model that accepts `image_paths`. **Rejected for CAD.** |
| `effort` | `low`, `medium`, `mad_max` | `low` when parametric | `text`, `image` | Requires `shape_model: parametric`. `low` runs the parametric pipeline. `medium` and `mad_max` research the described product and author the model; they cost more and take longer. **Rejected for CAD.** |
| `texture_model` | `auto` | `auto` | all | Selects the supported texture model. There is no other public value, so omit it. |
| `apply_textures` | boolean | `true` with a CAD reference image, `false` without one | `cad` | Generate textures from the reference image. `true` requires `image_path`. When it is off, `texture_model` has nothing to run. |

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

- `text` accepts no files and rejects `apply_textures`.
- `image` requires exactly one of `image_path`, `image_paths`, or `views`.
- `views` needs at least 2 entries, and at most 4 under `auto` or `diffusion`.
- `image_paths` requires `shape_model: parametric`.
- `image` rejects `mesh_path`, `datasheet_path`, `units`, `meters_per_unit`, `up_direction`, and
  `apply_textures`.
- `cad` requires `mesh_path`, accepts an optional `image_path`, and rejects
  `image_paths`, `views`, `reconstruct`, `mesh_quality`, `shape_model`, and `effort`. Source-frame fields
  then follow the file-format rules above.
- `effort` requires `shape_model: parametric` on text or image requests.
- The legacy `reconstruct` field is ignored by the current Queue. The client
  rejects it with `effort: medium` or `mad_max`; omit it on all new requests.
- `apply_textures: true` on CAD requires `image_path`.
- Strict decimation requires exactly one target. Any other mode accepts none.
- The four CAD reuse flags are rejected for `text` and `image`.
- `keep_existing_shape` and `physics_validation_only` are rejected alongside
  `regenerate_parts: true`, because they ask for opposite things.
- `keep_existing_textures` and `physics_validation_only` are rejected alongside
  `apply_textures: true`, for the same reason.
- `body_type: soft_bodies` accepts only `newton_solver: vbd`, and
  `body_type: rigid_bodies` rejects `vbd`.
- OBJ, GLTF, STL, PLY, and FBX reject explicit requests to keep authored
  appearance. With a reference image, they also reject `apply_textures: false`.
  GLB is accepted for inspection; the API may reject it if no bound embedded
  texture survives the upload.
