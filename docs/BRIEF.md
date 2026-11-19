# DC6 — brief, version 2

Version 1 is kept as `BRIEF-v1.md`. This version replaces its sections 4.1, 4.2, 4.3.1–4.3.3, 6 and 8.
Sections 4.4 to 4.8 (decals, symmetry, export, project files, brand), 5 (not in scope) and 7 (code style) of version 1 stand as written.

## What changed and why

Version 1 had DC6 work out the rocket by itself: which faces are the outside, where the axis is, which parts are fins.
Real parts (fused internals, threaded joints, windows) defeat that.
In version 2 the user builds the rocket in DC6, the way a rocket is built in the KSP vehicle editor, so DC6 knows these things because the user did them.

## Using DC6

### The rocket lies on its side

Livery has to read correctly when the rocket is pitched 90° from vertical, so DC6 shows the rocket horizontal everywhere: nose to the right, in the 3D view and on the flat page. Lettering placed the natural way then comes out the right way up, and never upside down by accident.

The window is split top and bottom: 3D view above, flat page below, both the full width of the window, with a draggable divider. This replaces the left and right split and the "nose up" rule of version 1.

### Building the rocket

1. Drag STEP files into the window. Each file (or each solid in an assembly file) lands in the parts list at the side.
2. Click a part in the list. It follows the cursor in the 3D view.
3. Move it near another part. It snaps on:
   * end to end, centred on the same axis (a nosecone onto a tube), or
   * onto the side of a part, standing out from the surface (a fin onto a tube).
   Click to drop it. The first part dropped is the root.
4. To fix a part that did not snap the way you wanted, use **place on face**, as in Bambu Studio: click a face on the part, then a face on the rocket, and the two are brought together, centred. This is also the quick way to join sections.
   The faces offered are not the CAD faces. They are the flat sides of the part's outer wrapping (its convex hull), largest first, as Bambu does it. So the open end of a nosecone is offered as one big disc although the real surface there is a thin ring, and a screw thread, a groove or a small boss offers nothing to get caught on. A handful of big faces per part, each one a place you would plausibly want to join.
5. A dropped part can be picked up again (its children come with it), nudged with a move gizmo, turned with a rotate gizmo, with angle snap on by default.
6. Symmetry works on parts as it does on decals: set ×4 and one fin becomes four, linked, around the axis.
7. A part can be hidden (internals, a sled). Hidden parts take no decals and are not exported.

A whole rocket exported as one STEP file is just a rocket with one part. Nothing above is needed; it stands on its own and decals go straight on.

Where a STEP file does not arrive pointing along its own axis, the user turns it with the rotate gizmo or place on face. DC6 may offer the obvious end faces as snap points, but the user decides.

### Putting livery on

As version 1, section 4.4: drag in an SVG, it sticks to the surface under the cursor at true size, slide it anywhere, across part joins. Place on face works for decals as well: click a face and the decal is centred on it.

### The flat page

The page beside the 3D view shows the rocket laid flat, built from the assembly:

* Parts stacked on the axis are unrolled around it into one body strip, nose to the right, 1:1 in millimetres. Only what can be seen from the side is drawn, so a spigot covered by the next section does not appear.
* Each part attached to the side (a fin, a canard, a pod) gets its own islands above and below the strip, at the station where it is attached, one per side for flat parts.
* The seam, wrapping, gores, layout and scale rules of version 1 (4.3.4 to 4.3.6) stand.

Moving a decal on the page and moving it in 3D are the same act.

### Export

As version 1, section 4.6.

## Build order

Each stage is shown to the team and tried on a real STEP file before the next begins.

1. **Parts and assembly.** Load STEP files, parts list, pick and drop with stack and side snapping, place on face, move and rotate gizmos, hide, part symmetry. Check: the test rocket is assembled from separate nose, tube, boattail and fin files in under a minute, and the team's own section files join correctly with place on face.
2. **Decals in 3D.** Check as version 1 stage 3.
3. **Cut export for one decal.** Check as version 1 stage 5.
4. **The flat page, linked to 3D.** Checks as version 1 stages 2 and 4, on rockets assembled in DC6.
5. **Decal symmetry.** Check as version 1 stage 6.
6. **Project save and load, undo, replacing a part with a revised STEP file.** Check as version 1 stage 7.
7. **Placement sheet and remaining exports.**

Decals and cut export come before the page because they are the point of the tool and do not depend on it.

## Decisions on record

* CAD: Fusion 360, Onshape, FreeCAD and OpenRocket. Files arrive both as single fused parts and as assemblies.
* Cutting is done by an outside factory with unknown software, so the cut SVG is kept as plain as possible: size in mm with a matching viewBox, absolute path data, no transforms, no CSS.
* STEP import uses `replicad-opencascadejs` (the maintained OpenCascade build; gives surface type per face and the face-to-triangle mapping).
* Deployment: static site at `d.c6.wiki`, source on GitHub, Cloudflare Pages.
