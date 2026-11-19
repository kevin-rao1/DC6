# DC6

Hosted at d.c6.wiki, a clankerslop livery design tool for rockets because nobody else made one.

DC6 puts cut-vinyl livery on a rocket in 3D and exports the cut shapes. It is a static browser app: no server, no install. The brief is in [`docs/BRIEF.md`](docs/BRIEF.md) (version 2, with [`docs/BRIEF-v1.md`](docs/BRIEF-v1.md) for the parts it does not replace).

Stage 1, parts and assembly, is what exists so far: drop STEP files in, build the rocket from them the way the KSP vehicle editor does it, lying on its side with the nose to the left.

## Using it

* Drop STEP files anywhere in the window, or click the + above the parts list. Each solid becomes a part in the list.
* Click a part in the list: it follows the cursor. The first part dropped is the root; it lies on the rocket axis. Other parts snap end to end onto free ends (the rings show where), or stand on the surface where the cursor is (a fin on a tube). Click to drop. Right click or Escape puts it back.
* Click a placed part to pick it up again; its children come with it. Q/E, W/S, A/D turn a held part.
* Symmetry (×1 to ×8, or X) makes linked copies around the axis.
* Move (2): drag the arrow to slide a part along the rocket, in whole mm (Shift 0.1 mm, Ctrl any direction). Rotate (3): 15° steps (Shift 1°). After either, a small panel shows what the drag did; type an exact value there to redo it with that value.
* Place on face (F): click a face of the selected part, then a face (or a spot on the surface) of another part. On the root, the face clicked becomes its aft end.
* The eye on a row of the tree at the right hides a part; the bin deletes it. Ctrl+Z / Ctrl+Shift+Z undo and redo.

## Running, building, testing

Needs Node 22 or later (the tools run TypeScript directly).

```
npm install
npm run dev                # development server
npm run build              # type check, then the static site in dist/
npm test                   # vitest: geometry, import, mating, document
npx tsc --noEmit           # type check only
npm run make-test-models   # regenerate test-models/*.step with OpenCascade
npm run e2e                # build, then drive the built app in Chromium with real mouse events
```

`?parts=nose,tube,can` in the URL loads those bundled test parts at start.

The e2e script needs Playwright and Chromium installed on the machine (`require('playwright')` must work); they are not dependencies of DC6. Screenshots go to `$DC6_E2E_OUT` or a scratch folder named in `tools/e2e.ts`.

## Dependencies, and why each is there

Runtime:

* **three** (three.js): the 3D view, orbit controls, and the move and rotate gizmos.
* **replicad-opencascadejs**, pinned at 1.2.1: the maintained WebAssembly build of OpenCascade. Reads STEP in any length unit, gives each face its surface type and the triangles of each face, which the later stages need. LGPL-2.1. Its .wasm is about 23 MB and loads in a Web Worker.
* **@fontsource/dm-sans**, **@fontsource/jetbrains-mono**: the interface fonts, self-hosted so the site makes no request to a font service.

Development:

* **vite**: development server and the static build.
* **typescript**: type checking (the code is TypeScript; Node and Vite strip the types).
* **vitest**: unit tests of the geometry layer and the document.
* **@types/node**, **@types/three**: type declarations.

## Code layout

* `src/geometry/` — no DOM, no three.js; runs in the worker, in Node and in tests. STEP import (`step-import.ts`, `step-text.ts`, `build-part.ts`), convex hull (`hull.ts`), attach faces from the hull (`attach-faces.ts`), ray casts (`bvh.ts`), rigid transforms and mating maths (`transform.ts`, `mating.ts`), the rocket axis (`rocket-axis.ts`).
* `src/model/` — the assembly document (plain data, later the project file) and undo history.
* `src/app/` — the browser app: `editor.ts` (state, pointer, keys), `picking.ts`, `stack-snap.ts`, `place-on-face.ts`, `gizmo.ts`, `view.ts`, `part-visuals.ts`, `ui.ts` (panels), `thumbnails.ts`, the import worker and the `window.dc6` test hook.
* `tools/` — test model generator, its dimensions, the e2e script.
* `test-models/` — the generated STEP test parts (also served at the site root for `?parts=`).

## Deploying

`npm run build` writes a static site to `dist/` with relative paths, so it works from any folder or domain. On Cloudflare Pages: build command `npm run build`, output directory `dist`. Pages allows at most 25 MiB per file; the largest file is the OpenCascade .wasm at about 22 MiB.
