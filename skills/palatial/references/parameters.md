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
| `image_path` | one PNG or JPEG path | none | `image`, `cad` | The single reference for `image`. Required, and required alongside the mesh, for `cad`. |
| `image_paths` | 2 to 50 PNG or JPEG paths | none | `image` | Photos of one object. Accepted **only** with `shape_model: parametric`. |
| `views` | object with `front`, `left`, `back`, `right` | none | `image` | Named angles of one object. Give at least 2. `auto` and `diffusion` accept at most 4. |
| `mesh_path` | path to the mesh file | none | `cad` | Required for CAD. |
| `datasheet_path` | path to a PDF | none | `cad` | Optional specification sheet. |

Each local input must be a regular file of at most 256 MiB. References must be
PNG or JPEG; datasheets must be PDF.

## What to build

| Field | Values | Default | Sources | Notes |
| --- | --- | --- | --- | --- |
| `create_articulation` | boolean | `false` | all | Create joints for moving parts such as doors, drawers, or wheels. Turn on only when the user needs the object to move. |
| `enable_parts_segmentation` | boolean | `true` | all | Split the object into separate rigid parts. Set `false` for one solid rigid mesh. |
| `run_simulation` | boolean | `true` | all | Run physics validation after the build. |
| `collision_quality` | `low`, `medium`, `high`, `x_high`, `sdf` | `medium` for ordinary rigid assets | all | Collision geometry fidelity. Soft-body assets use `sdf`; this public client creates ordinary rigid assets unless the service determines otherwise. |
| `mesh_quality` | `low`, `medium`, `high` | `high`; `medium` when parts segmentation is off and articulation is not requested | `text`, `image` | Generation quality. **Rejected for CAD**, which starts from a mesh the user supplied. |

## Shape and texture models

| Field | Values | Default | Sources | Notes |
| --- | --- | --- | --- | --- |
| `shape_model` | `auto`, `diffusion`, `parametric` | `auto` | `text`, `image` | `auto` lets Palatial select a supported route. `diffusion` is faster, cheaper, and better at organic shapes; it takes one image or up to 4 named views. `parametric` is more controllable and better for articulation; it is the only model that accepts `image_paths`. **Rejected for CAD.** |
| `texture_model` | `auto` | `auto` | all | Selects the supported texture model. There is no other public value, so omit it. |
| `apply_textures` | boolean | `true` | `cad` | Generate textures from the reference image. CAD only. When it is off, `texture_model` has nothing to run. |

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

## Scale and orientation

| Field | Values | Default | Sources | Notes |
| --- | --- | --- | --- | --- |
| `units` | `m`, `cm`, `mm`, `inch`, `feet` | `m` for text; format-dependent for CAD | `text`, `cad` | Required for OBJ, GLB, GLTF, STL, PLY, and FBX. Omit for STEP/IGES and USD-family files. |
| `up_direction` | `x`, `y`, `z` | `y` for text; format-dependent for CAD | `text`, `cad` | Required for OBJ, GLB, GLTF, STL, PLY, FBX, STEP, and IGES. Omit for USD-family files. |

CAD source-frame rules come from the file format:

- OBJ, GLB, GLTF, STL, PLY, and FBX require both `units` and `up_direction`.
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
- `image` rejects `mesh_path`, `datasheet_path`, `units`, `up_direction`, and
  `apply_textures`.
- `cad` requires both `mesh_path` and one `image_path`, and rejects
  `image_paths`, `views`, `mesh_quality`, and `shape_model`. Source-frame fields
  then follow the file-format rules above.
- Strict decimation requires exactly one target. Any other mode accepts none.
