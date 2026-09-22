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
  "engine": ["isaac_sim"],
  "units": "mm",
  "enable_parts_segmentation": false
}
```

`enable_parts_segmentation: false` is there because the bin is one solid object.
Without it the default splits the result into parts.

## One image

A single photo or render of the object.

```json
{
  "source": "image",
  "name": "Handheld scanner",
  "description": "A handheld barcode scanner roughly 180 mm long with a pistol grip, rigid, trigger does not need to move.",
  "engine": ["isaac_sim"],
  "image_path": "./references/scanner.jpg"
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
  "engine": ["isaac_sim", "mujoco"],
  "shape_model": "diffusion",
  "views": {
    "front": "./references/chair-front.jpg",
    "back": "./references/chair-back.jpg",
    "left": "./references/chair-left.jpg"
  },
  "create_articulation": true
}
```

## Many photos, parametric

A phone walkaround of one object. `image_paths` works only with `parametric`.

```json
{
  "source": "image",
  "name": "Tool cabinet",
  "description": "A steel tool cabinet about 900 mm tall with three drawers that open and close on rails.",
  "engine": ["isaac_sim"],
  "shape_model": "parametric",
  "image_paths": [
    "./references/cabinet-01.jpg",
    "./references/cabinet-02.jpg",
    "./references/cabinet-03.jpg",
    "./references/cabinet-04.jpg"
  ],
  "create_articulation": true
}
```

## CAD

A mesh the user already has, plus a reference image so textures have something
to follow.

```json
{
  "source": "cad",
  "name": "Parallel gripper",
  "description": "A two-finger parallel gripper. The fingers travel along the rail; the body is fixed.",
  "engine": ["isaac_sim"],
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
  "engine": ["isaac_sim"],
  "mesh_path": "./cad/roller.usdc",
  "image_path": "./references/roller.png",
  "create_articulation": true,
  "physics_validation_only": true
}
```

`physics_validation_only` skips appearance and parts regeneration and runs
collision, physics and validation on what was supplied. Do not add
`apply_textures` or `regenerate_parts` here: both contradict it and the request
is rejected. USD-family files carry their own units and up axis, so neither is
given.

## A soft object

Cloth, garments, cable, and rope deform instead of holding a shape.

```json
{
  "source": "text",
  "name": "Cotton tote bag",
  "description": "An empty cotton tote bag, about 380 by 420 mm, two woven handles, soft unlined fabric that drapes.",
  "engine": ["newton"],
  "body_type": "soft_bodies",
  "newton_solver": "vbd",
  "enable_parts_segmentation": false
}
```

Soft bodies simulate in Newton, so `engine` says `newton` and the solver is
`vbd`, the only one soft bodies accept. A soft object is one piece, so parts
segmentation is off. Leave `body_type` out entirely for ordinary solid objects.

## A hard polygon budget

Only when the user gives a number. Strict mode takes exactly one target.

```json
{
  "source": "text",
  "name": "Pallet",
  "description": "A standard EUR wooden pallet, 1200 by 800 by 144 mm, rigid.",
  "engine": ["isaac_sim"],
  "units": "mm",
  "enable_parts_segmentation": false,
  "decimation_mode": "strict",
  "decimation_target_faces": 20000
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
