# DC6 — livery maker for C6 Aerospace rockets

This is the project brief. Read all of it before writing any code.

## 1. What this is

DC6 is a tool for arranging rocket livery directly on the 3D airframe and exporting cut paths for a vinyl cutter. The team currently designs livery flat and cannot judge how it sits on the real shape.

DC6 is a placement tool, not a drawing tool. Artwork is drawn elsewhere and comes in as SVG. DC6 does not try to replace a vector or image editor.

The output is cut vinyl: single-colour vinyl sheet, cut along vector outlines, weeded, and applied by hand with transfer tape. It is not printed. Every exported shape is a closed vector outline in one vinyl colour.

The airframes have complex curvature along their whole length (not just tubes and cones), plus flat fins and canards. DC6 must treat curved surfaces as the normal case, not as an exception.

## 2. The one rule everything follows from

The 3D surface is the source of truth. The 2D page and the cut file are both computed from it.

A decal is stored as a shape attached to the surface: an anchor point on the surface, a rotation, a size in millimetres, and the vector artwork. It is not stored as coordinates on the 2D page.

What the user must be able to rely on, every time, on every surface:

1. A decal looks undistorted in the 3D view, at its true size measured along the surface. A 20 mm circle is 20 mm across in every direction, wherever it is put.
2. A decal slides continuously over the whole airframe. CAD face boundaries, unwrap seams and changes in curvature cause no jump, tear, flip or rescale.
3. The exported cut outline for a decal is the flat shape that, when applied to the rocket at the marked position, lands where the 3D view showed it.
4. Editing on the 2D page and editing in the 3D view are the same operation on the same decal. Neither side can get out of step with the other.

There are no modes, warnings or special cases the user has to learn for curved surfaces. If a surface is developable (plane, cylinder, cone) the flat shape is exact. If it is doubly curved, the flat shape is the lowest-strain flattening of the patch the decal covers; vinyl stretches enough to take up the difference for decal-sized pieces. DC6 just does the right thing in both cases.

## 3. Platform and stack

* Static browser app, hosted at `d.c6.wiki` (static site, source on GitHub, Cloudflare Pages likely). No server-side code, no install. Must run in current Chrome and Firefox on Windows and Linux.
* TypeScript, three.js for the 3D view, SVG or Canvas 2D for the page.
* STEP import through a WebAssembly build of OpenCascade. Check what is currently maintained before choosing a package (occt-import-js and opencascade.js are the two to compare). The choice must give access to per-face surface type and the face-to-triangle mapping, not only a triangle soup.
* Everything in millimetres internally.

## 4. Requirements

### 4.1 Model import

* Load a STEP file (single part or assembly) by file picker or drag and drop.
* Tessellate finely enough that curved outlines look smooth at full zoom.
* Keep, for every triangle, which CAD face it came from and that face's surface type (plane, cylinder, cone, sphere, torus, surface of revolution, freeform).
* Stitch faces into one connected exterior surface so decals can cross face boundaries.
* Show exterior faces only. Internal parts and inner walls are detected automatically (not visible from outside) and hidden; the user can override per part.
* Detect the rocket's long axis automatically. Let the user correct it.
* Detect repeated parts around the axis (fins, canards) and record them as instances of one another. Symmetry (4.5) depends on this.

### 4.2 Layout: 3D view and 2D page

* Vertical split: 3D view on one side, 2D unwrapped page on the other. Draggable divider.
* 3D view: orbit, pan, zoom. Preset views (side, top, nose-on, tail-on).
* 2D page: pan, zoom, rotate.
* Selecting a decal on either side selects it on the other. Hovering a point on one side shows the matching point on the other.

### 4.3 Auto-unwrap (the 2D page)

This is the part of DC6 most likely to be done badly, and the part the team cares about most. A generic texture-atlas unwrap (xatlas, Blender "Smart UV Project") is not acceptable: those produce many small islands, rotated arbitrarily and packed for density. DC6's page must read as the rocket laid flat, and a designer must be able to work on it without looking at the 3D view to find out what an island is.

Loading a model gives a finished page with no user input.

#### 4.3.1 What "good" means, in priority order

1. Recognisable. Every island is identifiable at a glance: the body as one long strip, each fin as its planform. Nose is up on every island, so "up" on the page means "toward the nose" everywhere.
2. Few islands. One island per thing a person would name (the body, a fin side), not one per CAD face. The target count for a rocket with a nose, body, boattail, 4 fins and 4 canards is: 1 body strip, 16 fin and canard sides, plus any flat end faces. Nothing else.
3. True scale. 1:1 in millimetres. Exact wherever the surface is developable. Where it is not, lengths are true along the body and around the body, and the remaining error is small and smooth.
4. Seams where nobody looks. Straight, along a line the user would choose, and never through the middle of a visible panel.
5. Stable. The same model always gives the same page. A revised model gives the same layout with the changed parts changed, not a reshuffled page.
6. Tidy. No overlaps, an even gap between islands, each island labelled with its part name.

#### 4.3.2 Step 1 — classify faces

Work in a frame where the rocket axis is one coordinate (station `s`) and roll angle `theta` is measured around it.

* A face is axisymmetric if it is a surface of revolution about the rocket axis. Do not rely on the STEP surface type alone: CAD often exports a lofted or spline body as a B-spline face. Test numerically as well: sample the face, and if radius depends only on station to within tolerance, treat it as axisymmetric.
* A face is flat if it is a plane, or within tolerance of one (a fin with a slight aerofoil section counts as near-flat).
* Everything else is freeform.
* A face is minor if it is too small to carry vinyl: fin edges, fillets, chamfers, hole walls, anything narrower than about 3 mm. Minor faces never become their own island.

#### 4.3.3 Step 2 — group faces into charts

* CAD commonly splits one cylinder into two 180° faces, and splits a body at every feature edge. Undo this: merge neighbouring faces whenever they join smoothly (tangent-continuous across the shared edge). Only a sharp edge ends a chart.
* Body chart: all connected axisymmetric faces, nose tip to tail, merged into one chart, across section joints, shoulders and smooth profile changes.
* End-face charts: flat ring or disc faces perpendicular to the axis (the base, a step between diameters) are each one island.
* Fin and canard charts: for each detected part instance, two charts: one per side. The thin edge faces around the perimeter are minor and are hidden.
* Fillets between a fin and the body are absorbed into the chart they join smoothly, not given an island.
* Other parts (rail buttons, pods, fairings): one chart per smooth region, using the same merge rule.
* Holes in the body (vents, fasteners) appear as holes in the body strip. Their inner walls are hidden.

#### 4.3.4 Step 3 — flatten each chart

* Flat charts: placed as they are. Exact.
* Body chart (silhouette strip): each point maps to `x = theta * r(s)`, `y = arc length along the profile`, where `r(s)` is the local radius. The strip's width at any station is the true circumference there, so the island looks like the rocket's side profile, widened. This is exact on every cylindrical section (most of a rocket), keeps along-body and around-body lengths true everywhere, and keeps nose-to-tail as one unbroken island.
* Tapered and curved sections of the body: the silhouette map shears toward the edges of the strip where the radius is changing. Where that shear would exceed a small budget (suggest 5%), split that section, and only that section, into equal gores (2, 3, 4…) so each gore stays under budget. The gores stay joined to the neighbouring cylindrical sections, so the body is still one island. When the rocket has fins or canards at that station, use the same count and put the gore cuts on the fin root lines.
* Freeform charts: flatten with ARAP, started from an LSCM solution, scaled so average area is preserved. If distortion is over budget, cut along the line of highest curvature and retry, up to a small limit on pieces.
* Each fin side is drawn as seen from outside the rocket looking at that side, so artwork on the page reads the way it will read on the vehicle.

#### 4.3.5 Step 4 — seams

* The body strip has one seam, a straight line along the body at a roll angle.
* Default seam angle: on a fin root line if the rocket has fins (the surface is already visually broken there), otherwise on the launch-rail side.
* The CAD file's own periodic-face seam is ignored. It has nothing to do with the page seam.
* The body strip wraps on the page. Panning the page sideways past the edge of the strip shows the strip repeating, so the user can always bring any part of the body to the middle and never has to work across a seam. Dragging the strip sideways is the same as rotating the rocket.
* A decal that crosses a seam or a gore cut is drawn on both sides of it. It is still one decal.

#### 4.3.6 Step 5 — layout

Layout is by meaning, not by packing density.

* Body strip in the centre of the page, nose up.
* Fin and canard islands in columns either side of the strip, at the height of the station where they attach, ordered by roll angle, root edge toward the strip.
* End faces above and below the strip at their station.
* Other parts in a tray at the side.
* Islands are never rotated to fit. Even gap between islands. Each island carries a small label (STEP part name, and side for fins).
* The page has a millimetre grid and a station ruler down the side of the body strip.

#### 4.3.7 How to know the unwrap is good

Build a debug overlay (checker pattern and a stretch heat map on both views) for development. It is a developer tool, not a user feature.

The unwrap passes when, on the test models in section 6:

* Cylinders, cones in a single gore, and planes: length error under 0.1%.
* A cylinder exported as two half faces produces one body island with no line down the middle.
* A spline-lofted body is recognised as axisymmetric and joins the body strip.
* The finned test rocket produces exactly the island count in 4.3.1.
* No island overlaps another. Every island has nose up.
* Loading the same file twice gives an identical page.
* Lengthening one body section by 10 mm changes the body strip's length and moves the islands below it down by 10 mm. Nothing else moves.
* Unwrap of a typical airframe completes in under 2 seconds.

### 4.4 Decals

* Source: imported SVG only. DC6 has no drawing, shape or text tools. Stripes, bands, lettering and logos are all drawn in another program and imported.
* An SVG may contain several colours; each colour becomes one vinyl colour within that decal.
* Text inside an imported SVG must already be converted to paths. If an SVG contains live text, say so on import rather than guessing a font.
* Place by dropping onto either the 3D view or the 2D page.
* Move, rotate, scale and flip directly on either side, with numeric entry as well.
* Mapping onto the surface uses a local geodesic map around the anchor (discrete exponential map or equivalent), so shape and size are preserved along the surface and face boundaries do not matter.
* A decal may be long enough to wrap fully around the body and overlap itself. This must work without special handling by the user.
* Replace artwork: re-import an edited SVG into an existing decal, keeping its position, rotation, size and symmetry.
* Layers: order, hide, lock, rename.
* Base colour per part, for preview only (paint or bare material).

### 4.5 Symmetry (KSP-style)

* Radial: repeat a decal N times around the rocket axis (N = 2, 3, 4, 6, 8 or typed). Editing one edits all.
* Mirror: reflect a decal across a plane through the axis. Option to flip the artwork or keep it readable (lettering must not come out backwards unless asked).
* On fins and canards, symmetry uses the detected part instances: a decal on one fin appears in the same place on every matching fin, and on the opposite face if mirror is on.
* Symmetry copies are linked instances, and can be "made unique" to break the link.

### 4.6 Export

* Cut SVG: millimetres, 1:1, closed paths only, hairline stroke and no fill. One file per vinyl colour, or one file with a layer per colour (user's choice). Each piece carries a small label outside the cut line with its decal name.
* Pieces are flattened individually (per section 2, point 3), not taken from the page, so seams and gore cuts never cut through a piece.
* Overlapping colours: option to export layered (pieces overlap when applied) or knocked out (lower pieces have the overlap removed). Default layered.
* Placement sheet (PDF or SVG): for each piece, its station from a chosen datum (default: aft end) and roll angle from the seam line, with a thumbnail. This is how the team puts each piece in the right place by hand.
* Preview exports: PNG of the 3D view, and the full 2D page as SVG.
* Texture export: the livery as a PNG texture plus the model as glTF, for rendering in Blender.

### 4.7 Project files and model updates

* Save and load a project as one file (JSON plus embedded artwork). The STEP file is referenced by name and hash, and can be embedded optionally.
* Undo and redo for every edit.
* Autosave to browser storage, wrapped in try/catch, as a convenience only. The saved project file is the real copy.
* Loading a revised CAD model keeps the livery. Each decal remembers its anchor as a 3D position and surface normal on the old model, and is re-attached to the nearest matching point on the new one. Decals whose anchor moved more than a few millimetres are listed for the user to check. Nothing is silently dropped.

### 4.8 Brand and interface

* Dark interface only. Background `#000000`, accent cerise `#e64097`. No light theme.
* Vinyl colour presets: cerise `#e64097` and black `#000000`, plus user-added colours.
* Interface type: DM Sans, with JetBrains Mono for numbers and measurements.

## 5. Not in scope

* Drawing, shape or text tools of any kind. Artwork comes from SVG.
* Raster images.
* Printed (full-colour) vinyl, gradients.
* Physically based materials and lighting beyond a clean preview.
* Automatic nesting of cut pieces to save vinyl.
* Editing the CAD geometry.

## 6. Build order

Build and verify each stage before starting the next. Each stage has a check that must pass.

1. Import and view. STEP loads, exterior shown, axis detected, part instances detected, orbit/pan/zoom. Check: a test assembly with internals shows only the outer shell; four fins are reported as four instances of one part.
2. Auto-unwrap and the 2D page. Check: every item in 4.3.7.
3. Surface decals in 3D. One imported SVG placed and dragged on the surface. Check: a 20 mm circle measures 20 mm ± 0.2 mm along the surface in both directions on a cylinder, a cone, a fin and a doubly curved section, and drags across every face boundary without a jump.
4. Linked editing. Check: every edit made on one side appears identically on the other; seam-crossing decals show on both sides of the seam; a decal longer than the circumference wraps and overlaps itself correctly.
5. Per-decal flattening and cut SVG. Check: on a cylinder the exported outline is identical to the input artwork; on a cone it matches the analytic unroll; on a doubly curved test surface, mapping the exported outline back onto the surface lands within 0.5 mm of the designed outline for a 40 mm decal.
6. Symmetry. Check: radial ×4 on the body and on a four-fin set; mirrored lettering stays readable by default.
7. Project save/load, undo, model reload. Check: reload a model with one section lengthened by 10 mm; decals elsewhere do not move, decals on that section are re-attached and listed.
8. Placement sheet and remaining exports.

Make the test STEP files with OpenCascade itself so the checks can run without the team's CAD:

* a plain cylinder, exported as two half faces
* a cone
* an ogive nose
* a body whose profile is a smooth spline, exported as a B-spline face
* a full rocket: ogive nose, tube, boattail, 4 fins with root fillets, 4 canards
* the same rocket with internals (a sled and a motor tube)
* the same rocket with the tube 10 mm longer

## 7. Code style

The maintainer reads every line and wants code a novice can follow.

* Plain syntax. One step per line. Named intermediate variables instead of nested expressions.
* No clever idioms: no chained one-liners, no destructuring tricks, no dense functional pipelines where a loop is clearer.
* Asserts at the point an invariant matters, with a message saying what was expected. Do not add limits or validation that the requirements above do not ask for.
* Comments state intent, and state doubt where there is any ("not sure this holds for a torus").
* Geometry code is kept apart from UI code, and is unit-tested against the analytic cases in section 6.
* Keep dependencies few. Say why each one is there.

## 8. Decisions (answered by the team)

1. CAD packages: Fusion 360, Onshape and FreeCAD/OpenRocket are all in use (SolidWorks is not). The airframe arrives sometimes as a single fused part and sometimes as an assembly. DC6 must handle both and must not depend on assembly structure or part names being present: fins and canards have to be found by geometry when the file is one solid.
2. Cutting is done by an outside factory, with unknown software. The cut SVG must therefore be as plain and portable as possible: explicit `width`/`height` in mm with a matching `viewBox`, absolute path data, no transforms, no CSS, no clip paths, no `<use>`; layers as plain `<g>` groups with an `id` (plus Inkscape layer attributes, which other software ignores).
