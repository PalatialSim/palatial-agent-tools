# Worked requests

Complete `palatial_create_asset` arguments for each source. Copy the shape,
replace the content, and leave out anything the user did not ask for.

## Text

The user describes the object and nothing else exists yet.

```json
{
  "source": "text",
  "name": "Storage bin",
  "description": "A rigid plastic storage bin, 600 by 400 by 320 mm, textured polypropylene, no lid, no moving parts. For warehouse picking simulation.",
  "engine": [
    "isaac_sim"
  ],
  "mode": "diffusion",
  "parameters": {
    "structure": "single_object"
  }
}
```

`parameters.structure: single_object` is there because the bin is one solid object.
Without it the default splits the result into parts.

## One image

A single photo or render of the object.

```json
{
  "source": "image",
  "name": "Handheld scanner",
  "description": "A handheld barcode scanner roughly 180 mm long with a pistol grip, rigid, trigger does not need to move.",
  "engine": [
    "isaac_sim"
  ],
  "image_path": "./references/scanner.jpg",
  "mode": "diffusion"
}
```

No `units` and no `up_direction`: image requests reject both. The size lives in
the description.

## Several angles, diffusion

Named views of one object. Two is enough, four is the maximum here.

```json
{
  "source": "image",
  "name": "Office chair",
  "description": "A five-castor office chair, about 1.1 m tall, fabric seat, with a swivelling seat and castors that roll.",
  "engine": [
    "isaac_sim",
    "mujoco"
  ],
  "views": {
    "front": "./references/chair-front.jpg",
    "back": "./references/chair-back.jpg",
    "left": "./references/chair-left.jpg"
  },
  "mode": "diffusion",
  "parameters": {
    "structure": "articulated_parts"
  }
}
```

## Many photos, parametric

A phone walkaround of one object. Parametric Low takes up to 50 photos.

```json
{
  "source": "image",
  "name": "Tool cabinet",
  "description": "A steel tool cabinet about 900 mm tall with three drawers that open and close on rails.",
  "engine": [
    "isaac_sim"
  ],
  "image_paths": [
    "./references/cabinet-01.jpg",
    "./references/cabinet-02.jpg",
    "./references/cabinet-03.jpg",
    "./references/cabinet-04.jpg"
  ],
  "mode": "parametric",
  "effort": "low",
  "parameters": {
    "articulation": true
  }
}
```

For Mad Max, use `mode: parametric` with `effort: mad_max` and remove
`parameters`: research decides the build settings. Use one engine and at most
8 photos (7 with a scanned GLB reference_mesh_path).

## CAD

A mesh the user already has, plus a reference image so textures have something
to follow.

```json
{
  "source": "cad",
  "name": "Parallel gripper",
  "description": "A two-finger parallel gripper. The fingers travel along the rail; the body is fixed.",
  "engine": [
    "isaac_sim"
  ],
  "mesh_path": "./cad/gripper.step",
  "image_path": "./references/gripper.png",
  "datasheet_path": "./cad/gripper-spec.pdf",
  "up_direction": "z",
  "create_articulation": true,
  "apply_textures": true
}
```

STEP and IGES require an up axis, but their conversion carries canonical scale,
so this request intentionally omits `units`. Direct mesh formats such as OBJ,
GLB, GLTF, STL, PLY, and FBX require both `units` and `up_direction`. USD-family
files use authored stage metadata and reject both fields.

## A CAD model that is already correct

The user supplied a mesh they are happy with and only wants it simulation-ready.

```json
{
  "source": "cad",
  "name": "Conveyor roller",
  "description": "A powered conveyor roller already modelled to spec. Keep the geometry and the appearance exactly as supplied; the roller spins on its axle.",
  "engine": [
    "isaac_sim"
  ],
  "mesh_path": "./cad/roller.usdc",
  "create_articulation": true,
  "physics_validation_only": true
}
```

`physics_validation_only` skips appearance and parts regeneration and runs
collision, physics and validation on what was supplied. Do not add
`apply_textures` or `regenerate_parts` here: both contradict it and the request
is rejected. USD-family files carry their own units and up axis, so neither is
given.

The USD file carries its authored material and texture references. A GLB with
embedded textures can also preserve its appearance if the API confirms a bound
texture inside the uploaded bytes. Other direct mesh formats cannot prove
external texture sidecars from one uploaded file. With no reference image,
they can instead stay untextured.

## A rigid object for Newton

```json
{
  "source": "text",
  "name": "Rigid storage bin",
  "description": "A rigid open polypropylene bin, 20 cm wide, 15 cm deep and 12 cm tall, no moving parts.",
  "engine": ["newton"],
  "mode": "parametric",
  "effort": "low",
  "parameters": {
    "articulation": false,
    "collision_quality": "auto",
    "newton_solver": "mujoco"
  }
}
```

The MCP omits the collision override for auto, using the API's current medium
choice on Low. A rigid object needs no body_type. Mad Max chooses proxies itself.

## A hard polygon budget

Only when the user gives a number. Strict mode takes exactly one target.

```json
{
  "source": "text",
  "name": "Pallet",
  "description": "A standard EUR wooden pallet, 1200 by 800 by 144 mm, rigid.",
  "engine": [
    "isaac_sim"
  ],
  "mode": "diffusion",
  "parameters": {
    "structure": "single_object",
    "decimation_mode": "strict",
    "decimation_target_faces": 20000
  }
}
```

## After it is built

```
palatial_get_asset            { "asset_id": "..." }
palatial_download_asset       { "asset_id": "...", "output_dir": "./assets/pallet" }
```

Download only once the status is `READY`, and into a directory the user named.
The tool writes the ZIP plus a receipt holding the SHA-256 and byte count, and
refuses to overwrite anything already there.

## Mad Max using your own photos

```json
{
  "source": "image",
  "name": "Tool cabinet Mad Max",
  "description": "Match this three-drawer steel tool cabinet, 900 mm tall. Its drawers open on rails.",
  "mode": "parametric",
  "effort": "mad_max",
  "engine": ["isaac_sim"],
  "image_path": "./references/cabinet.jpg",
  "product_research": "specs_only"
}
```

## Product video

```json
{
  "source": "image",
  "name": "Desk lamp from video",
  "description": "A desk lamp with a weighted base, hinged two-part arm and tilting cone shade. Match the movement shown in the video.",
  "mode": "parametric",
  "effort": "low",
  "engine": ["mujoco"],
  "video_path": "./references/lamp.mp4",
  "product_research": "specs_only"
}
```

Video research settles the build settings, so parameters is omitted. The same
rule applies when mode is diffusion or effort is mad_max.
