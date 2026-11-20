# DC6

Hosted at d.c6.wiki, a clankerslop livery design tool for rockets because nobody else made one.

DC6 puts cut-vinyl livery on a rocket in 3D and exports the cut shapes. It is a static browser app: no server, no install. The brief is in [`docs/BRIEF.md`](docs/BRIEF.md) (version 2, with [`docs/BRIEF-v1.md`](docs/BRIEF-v1.md) for the parts it does not replace).

Stages 1 to 4 exist so far: drop STEP files in and build the rocket from them the way the KSP vehicle editor does it, lying on its side with the nose to the left; drop SVG artwork on it as cut vinyl decals; export the cut file; work on the decals on the flat page under the 3D view as well.

## Using it

* Drop STEP files anywhere in the window, or click the + above the parts list. Each solid becomes a part in the list.
* Click a part in the list: it follows the cursor. The first part dropped is the root; it lies on the rocket axis. Other parts snap end to end onto free ends (the rings show where), or stand on the surface where the cursor is (a fin on a tube). Click to drop. Right click or Escape puts it back.
* Click a placed part to pick it up again; its children come with it. Q/E, W/S, A/D turn a held part.
* Symmetry (×1 to ×8, or X) makes linked copies around the axis.
* Move (2): drag the arrow to slide a part along the rocket, in whole mm (Shift 0.1 mm, Ctrl any direction). Rotate (3): 15° steps (Shift 1°). After either, a small panel shows what the drag did; type an exact value there to redo it with that value.
* Place on face (F): click a face of the selected part, then a face (or a spot on the surface) of another part. On the root, the face clicked becomes its aft end.
* The eye on a row of the tree at the right hides a part; the bin deletes it; the dot sets its preview colour. Ctrl+Z / Ctrl+Shift+Z undo and redo.
* Parts dropped on the side of another snap their roll angle to 15° steps from straight up (Shift: free), so a ×4 fin set sits square. After a rotate, the panel's Axis / Up / Side buttons change the axis it turned about.

### Decals

* Drop SVG files in the window (or the +). Each appears below the parts. Click one: it follows the cursor, stuck to the surface at true size, upright (artwork up is world up, so lettering on the side reads left to right). Click to drop. Right click or Escape puts it back.
* Press and drag a decal to slide it over the surface, across CAD faces and part joints. Corner handles scale it (uniformly, about its centre); the round handle turns it in 15° steps from upright (Shift: free). H and V flip it, Ctrl+D duplicates it (the copy follows the cursor), Delete removes it.
* After a move, rotate or scale the panel at the bottom left shows what it did (along / around in mm, angle from upright, width and height linked); type a value to redo it exactly.
* Place on face (F) with a decal selected: click a part's face and the decal is centred there, upright.
* The decal list under the rocket tree is the layer stack (top layer first): drag rows to reorder, eye to hide, lock to make a decal unclickable in the view, double-click the name to rename, the swatches to choose the vinyl colour of each artwork colour (cerise, black, or any other), the arrows (on hover) to replace the artwork with an edited SVG keeping position, rotation and scale.
* Export writes the cut SVG: one file per vinyl colour or one file with a layer per colour, colours layered or with overlaps knocked out.

### The flat page

* Once a part is placed the window splits: the 3D view above, the rocket laid flat below. Drag the line between them to resize; double-click it to put it back; drag it to the bottom to put the page away.
* The body is one strip, nose to the left, 1:1 in mm: x is the distance from the nose tip along the body (the ruler along the top), y goes round the rocket, so the strip's height at any station is the circumference there. The middle line of the strip is the side the 3D view faces; the top and bottom edges are the seam, on the back. Past each edge the strip carries on, faded, for a sixth of a turn (60 degrees), so a decal can be worked across the seam. Flat faces (fin sides, a base disc) are islands above and below the strip at their station, each labelled with its part and, for a fin, which side (seen from the tail with the fin pointing up).
* Drag empty space (or with the middle or right button) to pan; two-finger scroll pans; the wheel or a pinch zooms about the cursor; Fit shows the whole page.
* Drag the strip up or down to roll the rocket: the 3D view turns about the axis with it. Side, Top, Nose and Tail put the roll back to 0.
* Decals on the page work exactly as in 3D (it is the same tool): click one from the list and click on the page, drag to slide (dragging onto another island moves it there), the corner handles scale, the round one turns, H / V / Ctrl+D / Delete / undo. An SVG file dropped on the page lands where it is dropped. A decal put on from the page stands upright as the page shows it.
* Hovering a point on either view marks the same point on the other.
* Not on the page: curved surfaces that are neither the body nor flat (a pod, a rounded fairing, the rounded edges of fins). Decals still go on them in 3D.

SVG import reads paths (arcs included), rect, circle, ellipse, polygon, polyline, groups, nested svg, use, transforms, fill / fill-rule / opacity from attributes, style attributes and simple style sheets. Live text, raster images and gradients cannot be cut: they are left out with a notice. Size comes from width and height in physical units (mm, cm, in, pt, pc); without them one user unit is taken as one CSS pixel (1/96 in).

## Running, building, testing

Needs Node 22 or later (the tools run TypeScript directly).

```
npm install
npm run dev                # development server
npm run build              # type check, then the static site in dist/
npm test                   # vitest: geometry, import, mating, document, SVG, decal map, cut export, flat page
npx tsc --noEmit           # type check only
npm run make-test-models   # regenerate test-models/*.step with OpenCascade
npm run e2e                # build, then drive the built app in Chromium with real mouse events
```

`?parts=nose,tube,can` in the URL loads those bundled test parts at start. Test artwork is in `test-models/art/`.

The e2e script needs Playwright and Chromium installed on the machine (`require('playwright')` must work); they are not dependencies of DC6. Screenshots go to `$DC6_E2E_OUT` or a scratch folder named in `tools/e2e.ts`.

## Dependencies, and why each is there

Runtime (stages 2 and 3 added none: the SVG reader, the XML reader and the polygon boolean for knockout are written plainly in `src/geometry/`):

* **three** (three.js): the 3D view, orbit controls, and the move and rotate gizmos.
* **replicad-opencascadejs**, pinned at 1.2.1: the maintained WebAssembly build of OpenCascade. Reads STEP in any length unit, gives each face its surface type and the triangles of each face, which the later stages need. LGPL-2.1. Its .wasm is about 23 MB and loads in a Web Worker.
* **@fontsource/dm-sans**, **@fontsource/jetbrains-mono**: the interface fonts, self-hosted so the site makes no request to a font service.

Development:

* **vite**: development server and the static build.
* **typescript**: type checking (the code is TypeScript; Node and Vite strip the types).
* **vitest**: unit tests of the geometry layer and the document.
* **@types/node**, **@types/three**: type declarations.

## Code layout

* `src/geometry/` — no DOM, no three.js; runs in the worker, in Node and in tests. STEP import (`step-import.ts`, `step-text.ts`, `build-part.ts`), convex hull (`hull.ts`), attach faces from the hull (`attach-faces.ts`), ray casts and nearby triangles (`bvh.ts`), rigid transforms and mating maths (`transform.ts`, `mating.ts`), the rocket axis (`rocket-axis.ts`). Decals: SVG reading (`xml.ts`, `svg-colours.ts`, `svg-path.ts`, `svg-import.ts`) into artwork (`artwork.ts`); a part's mesh welded into one walkable surface (`surface-mesh.ts`); straight walks across the surface and from part to part (`geodesic.ts`); the forward map of a flat decal onto the surface (`decal-map.ts`); the cut file (`cut-export.ts`) with its polygon boolean (`polygon-boolean.ts`). The flat page: the body strip (`page-strip.ts`: profile, which triangles are skin, the strip cut at the seam for a roll), the flat islands (`page-islands.ts`), and the page itself with its layout, the two maps between surface and page, and decals pushed onto the page (`page.ts`).
* `src/model/` — the assembly document (plain data, later the project file) with its decals (`decals.ts`), and undo history.
* `src/app/` — the browser app: `editor.ts` (state, pointer, keys), `picking.ts`, `stack-snap.ts`, `place-on-face.ts`, `gizmo.ts`, `view.ts`, `part-visuals.ts`, `decal-tool.ts` (placing, sliding, handles, drawing decals; it takes the pointer from either view through `DecalPointer`), `page-pane.ts` (the flat page: drawing, pan and zoom, the page as a decal pointer, hover links), `split.ts` (the two panes and the divider), `decal-visuals.ts` (draped mesh, texture, handles), `ui.ts` and `decal-panels.ts` (panels, layer list, colours, export), `thumbnails.ts`, the import worker and the `window.dc6` test hook.
* `tools/` — test model generator, its dimensions, the e2e script.
* `test-models/` — the generated STEP test parts (`tube-long` is the tube 10 mm longer, for the page's stability check) (also served at the site root for `?parts=`), and test SVG artwork in `art/`.

## Deploying

`npm run build` writes a static site to `dist/` with relative paths, so it works from any folder or domain. On Cloudflare Pages: build command `npm run build`, output directory `dist`. Pages allows at most 25 MiB per file; the largest file is the OpenCascade .wasm at about 22 MiB.
