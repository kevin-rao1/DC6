# DC6
Hosted at d.c6.wiki, a clankerslop livery design tool for rockets because nobody else made one.

The brief is in [docs/BRIEF.md](docs/BRIEF.md). This README says how the code is
built and why. Status: **stage 1 (import and view)** of the brief's build order.

## Running it

```
npm install
npm run dev               # Vite dev server
npm run build             # type-check, then static site in dist/
npm test                  # vitest, against the checked-in STEP files
npm run make-test-models  # regenerate test-models/*.step with OpenCascade
npm run smoke             # build, serve dist/, load test rockets in Chromium, screenshot
```

`npm run smoke` needs Playwright with Chromium installed on the machine; it is
not a dependency of DC6. Screenshots go to `$TMPDIR/dc6-smoke` (or `--out <folder>`).

Developer affordance: `?model=rocket-assembly` (any name in `test-models/`, without
`.step`) loads a bundled test model; `&view=side|top|nose|tail` picks a preset view.
After loading, `window.dc6` holds a short summary for automated checks.

### Deploying (Cloudflare Pages)

Build command `npm run build`, output folder `dist`. The site is fully static and
makes no third-party requests (fonts are bundled). The OpenCascade wasm file is
22.9 MB, under Cloudflare Pages' 25 MiB per-file limit. The test models are copied
to the site root (Vite `publicDir`), about 3 MB, so `?model=` also works there.

## Dependencies, and why each is there

| Package | Why |
|---|---|
| `replicad-opencascadejs` 1.2.1 (LGPL-2.1) | STEP import through a WebAssembly build of OpenCascade (see below). |
| `three` | The 3D view (brief section 3). `OrbitControls` comes from its addons. |
| `@fontsource/dm-sans`, `@fontsource/jetbrains-mono` | The interface fonts (brief 4.8), self-hosted: Vite bundles the font files into `dist/assets`, so there are no requests to Google Fonts. |
| dev: `vite`, `typescript`, `vitest`, `@types/three`, `@types/node` | Build, strict type checking, tests. |

Node 22.18+ runs the TypeScript tools (`tools/*.ts`) directly (type stripping), so
there is no `tsx`/`ts-node`. The code uses only erasable TypeScript syntax for that
reason (`erasableSyntaxOnly`).

### Choice of OpenCascade package

The brief requires per-face surface type and the face-to-triangle mapping, not only
a triangle soup, plus STEP *writing* to make the test files.

* `occt-import-js` (last release 2024-12): triangles with per-face triangle ranges,
  but no surface type and no modelling or STEP writing. Not enough.
* `opencascade.js` 1.1.1 (2023, 66 MB) or the 2.0 beta: complete, but old or beta,
  and very large.
* **`replicad-opencascadejs` 1.2.1** (published 2026-11, maintained, 23 MB wasm):
  a custom opencascade.js build used by replicad. It has `STEPControl_Reader/Writer`,
  `STEPCAFControl_Writer` with XCAF documents (for named assemblies),
  `BRepAdaptor_Surface` (surface type and analytic parameters), `BRepMesh`, a fast
  `ReplicadMeshExtractor` that returns the whole tessellation with per-face groups,
  and the modelling tools the test generator needs (revolve, loft, prism, fillet,
  booleans, B-spline conversion). Chosen.

Gaps found and how they are handled:

* No `STEPCAFControl_Reader`, so part names are not read by OpenCascade. They are
  read from the STEP text instead (`src/geometry/step-text.ts`) and matched to solids
  by order; see "Part names" below.
* `gp_Cone` and `gp_Torus` are not bound (`Cone()`/`Torus()` return `unknown`), so
  cone and torus axes are found by evaluating the surface (`step-import.ts`).
* No `TopExp::MapShapesAndAncestors`: face adjacency comes from welding the
  tessellation instead (`mesh.ts`).
* No `BRepPrimAPI_MakeCone`: cones are made by revolving a profile.
* A circular arc revolved into a surface of revolution did not survive a STEP round
  trip in this build (the re-read face had an empty parameter range and did not
  tessellate). The generator writes the ogive arc as an exact rational B-spline
  instead, and re-reads every file it writes to check it is valid and every face
  tessellates.

The wasm is loaded once, in a Web Worker (`src/app/import-worker.ts`), as soon as
the page opens, with a visible loading state. The same import code runs under Node
for vitest and the generator (`src/geometry/occ.ts`).

## Code layout

Geometry is kept apart from the interface: nothing in `src/geometry` imports three.js
or touches the DOM, and only `occ.ts` and `step-import.ts` touch OpenCascade.

| File | What it does |
|---|---|
| `src/geometry/types.ts` | The public data structures (below). |
| `src/geometry/occ.ts` | Loads the OpenCascade wasm (browser worker or Node). |
| `src/geometry/step-import.ts` | STEP bytes to parts, faces (surface type + parameters) and per-face triangles. |
| `src/geometry/step-text.ts` | Small STEP text reader: length unit, product names, solid order. |
| `src/geometry/tessellation.ts` | Tessellation settings and the reasoning for them. |
| `src/geometry/mesh.ts` | Welds per-face triangles into one mesh with a face id per triangle. |
| `src/geometry/bvh.ts` | Bounding volume hierarchy: ray casting and closest-point queries. |
| `src/geometry/exterior.ts` | Exterior detection by ray casting; orients faces outwards. |
| `src/geometry/topology.ts` | Adjacency of the shown surface, components, manifold/orientation checks. |
| `src/geometry/contact.ts` | Contact links where separate parts touch (fin root on tube). |
| `src/geometry/axis.ts` | Long axis, nose end, axisymmetric faces, cylindrical coordinates. |
| `src/geometry/instances.ts` | Repeated parts around the axis (fins, canards). |
| `src/geometry/model.ts` | The pipeline after OpenCascade; `reanalyse` after user overrides. |
| `src/geometry/vec3.ts` | Small vector helpers. |
| `src/app/main.ts` | App shell: file picker, drag and drop, worker, state. |
| `src/app/import-worker.ts`, `worker-protocol.ts` | The import worker and its messages. |
| `src/app/viewer.ts` | three.js view: orbit/pan/zoom, preset views, edges, axis line. |
| `src/app/parts-panel.ts` | Model summary, axis controls, repeated parts, per-part override. |
| `src/app/split.ts` | Draggable divider between the 3D view and the (empty) 2D page. |
| `tools/test-model-params.ts` | Every dimension of the test models, in one place. |
| `tools/make-test-models.ts` | Writes `test-models/*.step` and `manifest.json`. |
| `tools/smoke.ts` | Browser smoke test. |
| `test/*.test.ts` | Unit tests against the test models. |

### Data structures for later stages (`src/geometry/types.ts`)

* `DcModel`: `fileName`, `sourceUnit`, `parts: CadPart[]`, `faces: CadFace[]`,
  `mesh: ModelMesh`, `axis: RocketAxis`, `instanceSets: InstanceSet[]`,
  `topology: ExteriorTopology`, deflection settings, `warnings`, `timings`.
* `ModelMesh`: `positions` (Float64Array, welded), `triangles` (Uint32Array),
  `cornerNormals` (Float32Array, 9 per triangle, from the CAD surface),
  `triangleFace` (Int32Array). Triangles are ordered by face.
* `CadFace`: `id`, `part`, `surface: SurfaceParams`, `triangleStart`, `triangleCount`,
  `area`, `visibleFraction`, `exterior`, `axisymmetric`.
* `SurfaceParams`: `kind` (`plane | cylinder | cone | sphere | torus | revolution | freeform`),
  `occType` (e.g. `BSplineSurface`), `axisOrigin`, `axisDirection`, `radius`,
  `semiAngle`, `minorRadius` (null where they do not apply).
* `CadPart`: `id`, `name`, `productName`, `instanceName`, `faceIds`, `area`,
  `exteriorAreaFraction`, `exterior`.
* `ExteriorTopology`: `included` (shown triangles), `neighbours` (3 per triangle, -1
  at an open edge), `component`, `componentCount`, `nonManifoldEdgeCount`,
  `inconsistentEdgeCount`, `contacts: ContactLink[]`.
* `RocketAxis`: `origin` (at the tail, station 0), `direction` (tail to nose),
  `source`, `stationMin`, `stationMax`, `noseConfidence`.
* `InstanceSet`: `name`, `members: InstanceMember[]` (`faceIds`, `partIds`,
  `rollDegrees`, `transformFromFirst` as a row-major 4x4, station range, area),
  `evenlySpaced`.
* `PartVisibility`: `'auto' | 'show' | 'hide'`, the per-part user override.

## How it works, and known weaknesses

**Units.** OpenCascade converts the file's length unit to millimetres on reading
(`xstep.cascade.unit = MM`). The unit the file declared is also read from the text
and shown. Tested with the cone file, which is written in inches.

**Tessellation.** Linear deflection 0.05 mm, angular 0.1 rad; reasoning in
`tessellation.ts` (the 100 mm tube gets a chord every 5.1 degrees and a sagitta under
half a pixel at full zoom; shading uses CAD normals). The whole shape is tessellated
in one call so neighbouring faces share edge nodes; faces are matched to their
triangles by the extractor's face hash.

**Part names.** Read from `PRODUCT` and `NEXT_ASSEMBLY_USAGE_OCCURRENCE` in the STEP
text and matched to solids by walking the product tree in the order OpenCascade's
reader returns solids (usages in entity order, depth first). If the number of named
solids differs from the number of solids, parts are numbered instead and a note is
shown. *Doubt:* the order is what OCCT does for our files and the usual exporters,
but it is not specified anywhere; a file from another exporter may get names
shuffled between solids. Nothing else depends on names (fins are found by geometry).

**Stitching.** Per-face triangles are welded: within a face only exactly coincident
nodes on the face's own boundary (periodic seams, cone apex), and only if that keeps
the face manifold; across faces any nodes within 1 micrometre. Within one solid this
gives one connected, consistently oriented exterior. Across touching parts of an
assembly, the nose, tube and boattail happen to share boundary nodes and are joined;
fins and canards are not (their root curve crosses the middle of the tube's
triangles), so each open boundary edge that lies on another part's surface (within
0.2 mm) gets a `ContactLink` to the nearest triangle there. *Not done:* imprinting
the fin root into the tube mesh. Later stages walking a geodesic across an assembly
fin root will have to step across a contact link, which is approximate there. A
fused single solid has no such issue.
*Known defect:* at one degenerate fillet corner OpenCascade's tessellation leaves
micro-cracks (fused rocket: 44 open edges, each under 0.3 mm, 5 mm in total) and, on
two fin placements of the assembly, a 5 micrometre sliver that makes two exterior
edges non-manifold. The tests fence these in rather than hide them.

**Exterior.** For sample points on each face (up to 160 triangle centroids), rays
are cast to 128 directions over the hemisphere on each side of the surface against a
BVH of all triangles. A point is *seen* if at least 15% of its hemisphere escapes; a
face is exterior if at least 50% of its area is seen; a part is exterior if at least
5% of its area is seen, and a hidden part hides all its faces. Rules and reasons are
in `exterior.ts`. On the internals model: the motor tube (aft ring visible through the
open tail, 0.2% of its area seen) and the sled are hidden, the tube's inner wall and
the boattail's inner wall (17% seen, through the open tail) are hidden, the open aft
ring of the boattail is shown, and joints between parts (nose base, tube ends, fin
roots) are hidden. The side that sees out orients each face. User override per part:
*auto* (faces classified exterior), *show* (all faces of the part), *hide*.
*Doubts:* a fixed direction set can miss a very narrow slot; coincident faces of two
parts are hidden by construction (right for a fin root, wrong for parts that overlap
without covering each other).

**Axis.** Principal axis of the exterior area, then refined to the area-weighted
consensus of exterior cylinder/cone/torus/revolution axes that agree within 3 degrees
(lines more than 1 mm off the consensus dropped). With no analytic faces (an all-B-
spline body) it is refined by fitting the line that surface normals cross (Gauss-
Newton with a robust weight). Error against the true axis: 0 (to double precision) on every test model with analytic faces, 1.5e-5 degrees on the B-spline body (normal fit),
including the off-axis fused rocket and the off-axis B-spline body.
**Nose:** the end whose last 3% of length has the smaller maximum radius, if smaller
by 20%; otherwise *uncertain* (shown to the user) with a fixed tie-break.
*Doubt:* a blunt nose with a long thin nozzle would be read backwards. The user can
choose the axis (+-X, +-Y, +-Z) and flip nose/tail; preset views follow the axis.

**Repeated parts.** Exterior faces that are not axisymmetric (tested numerically: the
normal has no circumferential component and the face spans at least 20 degrees of
roll, or an analytic axis on the rocket axis) are grouped by mesh connectivity; groups
with matching area, station and radius are confirmed by rotating sample points about
the axis onto the other group (95% within 0.25 mm, both ways). This works the same for
an assembly and for a fused solid. Sets are named from a shared product name when
each member is its own part, otherwise by position (aft half "fin", fore half
"canard"). The 95% (not 100%) is because OpenCascade built one fin's fillet corners up
to 2.7 mm differently in the fused model. *Doubts:* mirror-image instances are not
matched; the naming by position is a guess.

## Test models (`test-models/`)

Made by `tools/make-test-models.ts` from `tools/test-model-params.ts` (100 mm diameter,
1450 mm long sounding rocket). `manifest.json` records each model's true axis.

| File | Contents |
|---|---|
| `cylinder-two-halves.step` | Cylinder whose side is two half-cylinder faces. |
| `cone.step` | Cone along +X, written in inches. |
| `ogive-nose.step` | Tangent ogive along -Y (surface of revolution). |
| `spline-body.step` | Lofted body, side is one B-spline face, axis along (1,1,1), off origin. |
| `rocket-assembly.step` | Assembly: nose, tube, boattail, 4 fins with root fillets (one fin product placed 4 times), 4 canards. |
| `rocket-fused.step` | The same rocket as one fused solid, axis along (0.3, 1, -0.4), off origin, rolled 10 degrees. |
| `rocket-internals.step` | Hollow tube and open boattail with a motor tube and an avionics sled; axis +X, rolled 22.5 degrees. |
| `rocket-long.step` | The assembly with the tube 10 mm longer. |
