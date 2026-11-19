// Generates the STEP test parts with OpenCascade itself, so the checks can run
// without the team's CAD.
//
// Run with:   npm run make-test-models
// Output:     test-models/*.step
//
// The files are checked in; tests and the app read them and do not regenerate
// them. All dimensions are in tools/test-model-dimensions.ts.
//
// Workarounds for this OpenCascade build (replicad-opencascadejs), learnt the
// hard way:
// - A revolved circular arc written to STEP re-reads as an invalid face, so
//   every arc in a profile is converted to a rational B-spline first.
// - There is no MakeCone binding we rely on; cones are revolved profiles.
// - STEPCAFControl_Writer.Transfer with an empty "multi" string writes one
//   file per part; Perform() writes one file.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOcc, noProgress } from '../src/geometry/occ.ts';
import type { Occ } from '../src/geometry/occ.ts';
import {
  body,
  nose,
  tube,
  can,
  boattail,
  fin,
  canard,
  sled,
  rocketStations,
  placements,
  inchFiles,
} from './test-model-dimensions.ts';
import type { Placement } from './test-model-dimensions.ts';

type Shape = InstanceType<Occ['TopoDS_Shape']>;
type Trsf = InstanceType<Occ['gp_Trsf']>;
type Edge = InstanceType<Occ['TopoDS_Edge']>;

const here = dirname(fileURLToPath(import.meta.url));
const outputDirectory = join(here, '..', 'test-models');

const oc = await loadOcc();

// ---------------------------------------------------------------------------
// Small helpers.

function point(x: number, y: number, z: number): InstanceType<Occ['gp_Pnt']> {
  return new oc.gp_Pnt(x, y, z);
}

function zAxis(): InstanceType<Occ['gp_Ax1']> {
  return new oc.gp_Ax1(point(0, 0, 0), new oc.gp_Dir(0, 0, 1));
}

// A profile in the XZ plane, x = radius, z = station. Each segment is either
// a straight line to the next point, or an arc through a middle point.
type ProfileStep = { kind: 'line'; to: [number, number] } | { kind: 'arc'; through: [number, number]; to: [number, number] };

function lineEdgeXZ(a: [number, number], b: [number, number]): Edge {
  return new oc.BRepBuilderAPI_MakeEdge(point(a[0], 0, a[1]), point(b[0], 0, b[1])).Edge();
}

function arcEdgeXZ(a: [number, number], through: [number, number], b: [number, number]): Edge {
  const arc = new oc.GC_MakeArcOfCircle(point(a[0], 0, a[1]), point(through[0], 0, through[1]), point(b[0], 0, b[1])).Value();
  // See the note at the top: a trimmed circle does not survive the STEP round
  // trip once revolved; an exact rational B-spline of the same arc does.
  const asBSpline = oc.GeomConvert.CurveToBSplineCurve(arc, oc.Convert_ParameterisationType.Convert_TgtThetaOver2);
  return new oc.BRepBuilderAPI_MakeEdge(asBSpline).Edge();
}

function revolveProfile(start: [number, number], steps: ProfileStep[]): Shape {
  const wireMaker = new oc.BRepBuilderAPI_MakeWire();
  let current = start;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    let edge: Edge;
    if (step.kind === 'line') {
      edge = lineEdgeXZ(current, step.to);
    } else {
      edge = arcEdgeXZ(current, step.through, step.to);
    }
    wireMaker.Add(edge);
    current = step.to;
  }
  const closes = Math.abs(current[0] - start[0]) < 1e-9 && Math.abs(current[1] - start[1]) < 1e-9;
  if (!closes) {
    throw new Error('revolveProfile: the profile must end where it starts');
  }
  const face = new oc.BRepBuilderAPI_MakeFace(wireMaker.Wire(), true).Face();
  const revolver = new oc.BRepPrimAPI_MakeRevol(face, zAxis(), 2 * Math.PI, false);
  return revolver.Shape();
}

// A closed polygon of straight steps, revolved.
function revolvePolygon(points: Array<[number, number]>): Shape {
  const steps: ProfileStep[] = [];
  for (let i = 1; i < points.length; i++) {
    steps.push({ kind: 'line', to: points[i] });
  }
  steps.push({ kind: 'line', to: points[0] });
  return revolveProfile(points[0], steps);
}

function fuse(a: Shape, b: Shape): Shape {
  const fuser = new oc.BRepAlgoAPI_Fuse(a, b, noProgress(oc));
  const result = fuser.Shape();
  if (result.IsNull()) {
    throw new Error('fuse failed');
  }
  return result;
}

function cut(a: Shape, b: Shape): Shape {
  const cutter = new oc.BRepAlgoAPI_Cut(a, b, noProgress(oc));
  const result = cutter.Shape();
  if (result.IsNull()) {
    throw new Error('cut failed');
  }
  return result;
}

// Merge faces that booleans split but that lie on one surface, as a CAD
// export of a single body has them.
function unify(shape: Shape): Shape {
  const unifier = new oc.ShapeUpgrade_UnifySameDomain(shape, true, true, false);
  unifier.Build();
  return unifier.Shape();
}

function transformed(shape: Shape, transform: Trsf): Shape {
  const transformer = new oc.BRepBuilderAPI_Transform(shape, transform, true, false);
  return transformer.Shape();
}

function rotationAboutZ(angleRadians: number): Trsf {
  const transform = new oc.gp_Trsf();
  transform.SetRotation(zAxis(), angleRadians);
  return transform;
}

function translation(x: number, y: number, z: number): Trsf {
  const transform = new oc.gp_Trsf();
  transform.SetTranslation(new oc.gp_Vec(x, y, z));
  return transform;
}

function cylinderAlong(origin: [number, number, number], direction: [number, number, number], radius: number, length: number): Shape {
  const frame = new oc.gp_Ax2(point(origin[0], origin[1], origin[2]), new oc.gp_Dir(direction[0], direction[1], direction[2]));
  return new oc.BRepPrimAPI_MakeCylinder(frame, radius, length).Shape();
}

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Shape {
  return new oc.BRepPrimAPI_MakeBox(point(x0, y0, z0), point(x1, y1, z1)).Shape();
}

// A flat plate: a polygon in the XZ plane extruded symmetrically along Y.
function plateXZ(points: Array<[number, number]>, thickness: number): Shape {
  const wireMaker = new oc.BRepBuilderAPI_MakeWire();
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    wireMaker.Add(new oc.BRepBuilderAPI_MakeEdge(point(a[0], -thickness / 2, a[1]), point(b[0], -thickness / 2, b[1])).Edge());
  }
  const face = new oc.BRepBuilderAPI_MakeFace(wireMaker.Wire(), true).Face();
  const prism = new oc.BRepPrimAPI_MakePrism(face, new oc.gp_Vec(0, thickness, 0), false, true);
  return prism.Shape();
}

function edgeMidpoint(edge: Edge): [number, number, number] {
  const curve = new oc.BRepAdaptor_Curve(edge);
  const middle = (curve.FirstParameter() + curve.LastParameter()) / 2;
  const p = curve.Value(middle);
  const result: [number, number, number] = [p.X(), p.Y(), p.Z()];
  curve.delete();
  return result;
}

// The placement of brief: local +Z onto `axis`, roll about it, then move.
function placementTransform(placement: Placement): Trsf {
  const ax = placement.axis[0];
  const ay = placement.axis[1];
  const az = placement.axis[2];
  const length = Math.sqrt(ax * ax + ay * ay + az * az);
  const w = [ax / length, ay / length, az / length];
  let helper = [1, 0, 0];
  if (Math.abs(w[0]) > 0.9) {
    helper = [0, 1, 0];
  }
  const dotHelper = helper[0] * w[0] + helper[1] * w[1] + helper[2] * w[2];
  const ux = helper[0] - dotHelper * w[0];
  const uy = helper[1] - dotHelper * w[1];
  const uz = helper[2] - dotHelper * w[2];
  const uLength = Math.sqrt(ux * ux + uy * uy + uz * uz);
  const u = [ux / uLength, uy / uLength, uz / uLength];
  const v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  const o = placement.origin;
  const align = new oc.gp_Trsf();
  // Columns are the images of local X, Y, Z.
  align.SetValues(u[0], v[0], w[0], o[0], u[1], v[1], w[1], o[1], u[2], v[2], w[2], o[2]);
  const roll = rotationAboutZ((placement.rollDegrees * Math.PI) / 180);
  return align.Multiplied(roll);
}

// ---------------------------------------------------------------------------
// The parts, each in its local frame (axis +Z).

// Tangent ogive profile from (radius, z0) to the tip at (0, z0 + length): the
// arc and the point at half length on it.
function ogiveMidpoint(radius: number, length: number): [number, number] {
  const rho = (radius * radius + length * length) / (2 * radius);
  const centreX = radius - rho;
  const half = length / 2;
  const x = centreX + Math.sqrt(rho * rho - half * half);
  return [x, half];
}

function solidOgive(radius: number, length: number): Shape {
  const middle = ogiveMidpoint(radius, length);
  return revolveProfile([0, 0], [
    { kind: 'line', to: [radius, 0] },
    { kind: 'arc', through: middle, to: [0, length] },
    { kind: 'line', to: [0, 0] },
  ]);
}

// Hollow ogive nose with a shoulder (spigot) below its base. Base at z = 0,
// shoulder from z = -shoulderLength to 0, open at the aft end.
function makeNose(): Shape {
  const outer = solidOgive(body.outerRadius, nose.length);
  const shoulder = revolvePolygon([
    [0, -nose.shoulderLength],
    [nose.shoulderOuterRadius, -nose.shoulderLength],
    [nose.shoulderOuterRadius, 0.5],
    [0, 0.5],
  ]);
  const solid = fuse(outer, shoulder);
  const innerRadius = body.outerRadius - nose.wall;
  // The cavity starts above a solid lip at the base, so that the shoulder and
  // the ogive shell are joined by material and form one solid.
  const innerOgive = solidOgive(innerRadius, nose.innerLength - nose.baseLip);
  const inner = transformed(innerOgive, translation(0, 0, nose.baseLip));
  const bore = revolvePolygon([
    [0, -nose.shoulderLength - 1],
    [nose.shoulderInnerRadius, -nose.shoulderLength - 1],
    [nose.shoulderInnerRadius, nose.baseLip + 0.5],
    [0, nose.baseLip + 0.5],
  ]);
  const hollow = cut(cut(solid, inner), bore);
  return unify(hollow);
}

function hollowCylinder(outer: number, inner: number, z0: number, z1: number): Shape {
  return revolvePolygon([
    [inner, z0],
    [outer, z0],
    [outer, z1],
    [inner, z1],
  ]);
}

function makeTube(): Shape {
  return hollowCylinder(body.outerRadius, body.outerRadius - body.wall, 0, tube.length);
}

// A helical thread ridge on a cylinder about Z: a triangular profile swept
// along a helix with the binormal held along Z (so the profile keeps its
// axial orientation, as a real thread does).
function threadRidge(): Shape {
  const frame = new oc.gp_Ax3(point(0, 0, can.threadStart), new oc.gp_Dir(0, 0, 1), new oc.gp_Dir(1, 0, 0));
  const surface = new oc.Geom_CylindricalSurface(frame, can.threadRootRadius);
  // On the unrolled cylinder (u = angle, v = height) a helix is a straight line.
  const line = new oc.Geom2d_Line(new oc.gp_Pnt2d(0, 0), new oc.gp_Dir2d(2 * Math.PI, can.threadPitch));
  const lengthOfOneTurn = Math.sqrt(4 * Math.PI * Math.PI + can.threadPitch * can.threadPitch);
  const helixEdge = new oc.BRepBuilderAPI_MakeEdge(line, surface, 0, can.threadTurns * lengthOfOneTurn).Edge();
  oc.BRepLib.BuildCurves3d(helixEdge);
  const spine = new oc.BRepBuilderAPI_MakeWire(helixEdge).Wire();
  // Profile in the XZ plane at the start of the helix (angle 0, x = root radius).
  const z = can.threadStart;
  const a: [number, number] = [can.threadRootRadius, z - can.threadHalfWidth];
  const b: [number, number] = [can.threadCrestRadius, z];
  const c: [number, number] = [can.threadRootRadius, z + can.threadHalfWidth];
  const profileMaker = new oc.BRepBuilderAPI_MakeWire();
  profileMaker.Add(lineEdgeXZ(a, b));
  profileMaker.Add(lineEdgeXZ(b, c));
  profileMaker.Add(lineEdgeXZ(c, a));
  const pipe = new oc.BRepOffsetAPI_MakePipeShell(spine);
  pipe.SetMode(new oc.gp_Dir(0, 0, 1));
  pipe.Add(profileMaker.Wire(), false, false);
  pipe.Build(noProgress(oc));
  if (!pipe.IsDone()) {
    throw new Error('thread sweep failed');
  }
  if (!pipe.MakeSolid()) {
    throw new Error('thread sweep did not close into a solid');
  }
  return pipe.Shape();
}

function makeCan(): Shape {
  const top = can.shellHeight;
  const spigotTop = top + can.spigotLength;
  // Shell with a concave (waisted) outside, the shoulder step at the top and
  // the spigot above it, open at the bottom.
  const shell = revolveProfile([can.innerRadius, 0], [
    { kind: 'line', to: [can.endRadius, 0] },
    { kind: 'arc', through: [can.waistRadius, top / 2], to: [can.endRadius, top] },
    { kind: 'line', to: [can.spigotCoreRadius, top] },
    { kind: 'line', to: [can.spigotCoreRadius, spigotTop] },
    { kind: 'line', to: [can.spigotBoreRadius, spigotTop] },
    { kind: 'line', to: [can.spigotBoreRadius, top] },
    { kind: 'line', to: [can.innerRadius, top] },
    { kind: 'line', to: [can.innerRadius, 0] },
  ]);
  let solid = fuse(shell, threadRidge());

  // The round window, and small radial holes near the bottom.
  const window = cylinderAlong([0, 0, can.windowHeight], [1, 0, 0], can.windowRadius, can.endRadius + 5);
  solid = cut(solid, window);
  for (let i = 0; i < can.smallHoleCount; i++) {
    const angle = (2 * Math.PI * (i + 0.5)) / can.smallHoleCount;
    const direction: [number, number, number] = [Math.cos(angle), Math.sin(angle), 0];
    const hole = cylinderAlong([0, 0, can.smallHoleHeight], direction, can.smallHoleRadius, can.endRadius + 5);
    solid = cut(solid, hole);
  }

  // Internal structure: radial struts from the wall, a central block, and a
  // ring on three legs at the bottom tip. All fused into the same solid.
  let internals: Shape | null = null;
  for (let i = 0; i < can.strutCount; i++) {
    const strut = plateXZ(
      [
        [can.strutInnerRadius, can.strutTop],
        [can.strutOuterRadius, can.strutTop],
        [can.strutOuterRadius, -2],
        [can.strutBottomOuterRadius, can.strutBottom],
        [can.strutInnerRadius, can.strutBottom],
      ],
      can.strutThickness,
    );
    const angle = (2 * Math.PI * i) / can.strutCount;
    const rolled = transformed(strut, rotationAboutZ(angle));
    if (internals === null) {
      internals = rolled;
    } else {
      internals = fuse(internals, rolled);
    }
  }
  if (internals === null) {
    throw new Error('expected struts');
  }
  const h = can.blockHalfSize;
  internals = fuse(internals, box(-h, -h, can.blockBottom, h, h, can.blockTop));
  for (let i = 0; i < can.strutCount; i++) {
    const angle = (2 * Math.PI * i) / can.strutCount;
    const x = can.legPitchRadius * Math.cos(angle);
    const y = can.legPitchRadius * Math.sin(angle);
    const legLength = can.strutBottom - can.ringTop + 1;
    const leg = cylinderAlong([x, y, can.ringTop - 0.5], [0, 0, 1], can.legRadius, legLength + 0.5);
    internals = fuse(internals, leg);
  }
  const ring = hollowCylinder(can.ringOuterRadius, can.ringInnerRadius, can.ringBottom, can.ringTop);
  internals = fuse(internals, ring);
  solid = fuse(solid, internals);
  return unify(solid);
}

function makeBoattail(): Shape {
  const length = boattail.length;
  return revolvePolygon([
    [boattail.aftRadius - boattail.wall, 0],
    [boattail.aftRadius, 0],
    [boattail.foreRadius, length],
    [boattail.foreRadius - boattail.wall, length],
  ]);
}

function solidBoattail(): Shape {
  return revolvePolygon([
    [0, 0],
    [boattail.aftRadius, 0],
    [boattail.foreRadius, boattail.length],
    [0, boattail.length],
  ]);
}

interface FinShape {
  rootChord: number;
  tipChord: number;
  span: number;
  sweep: number;
  thickness: number;
  edgeRadius: number;
}

// A swept plate. Root along z from 0 (trailing) to rootChord (leading) at
// x = 0, tip at x = span. The leading edge, trailing edge and tip are rounded;
// the root stays square.
function makeFinShape(shape: FinShape): Shape {
  const rootLeading = shape.rootChord;
  const tipLeading = shape.rootChord - shape.sweep;
  const tipTrailing = tipLeading - shape.tipChord;
  const plate = plateXZ(
    [
      [0, 0],
      [0, rootLeading],
      [shape.span, tipLeading],
      [shape.span, tipTrailing],
    ],
    shape.thickness,
  );
  const filleter = new oc.BRepFilletAPI_MakeFillet(plate, oc.ChFi3d_FilletShape.ChFi3d_Rational);
  const explorer = new oc.TopExp_Explorer(plate, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  const seen: string[] = [];
  let count = 0;
  while (explorer.More()) {
    const edge = oc.TopoDS.Edge(explorer.Current());
    const middle = edgeMidpoint(edge);
    const key = middle[0].toFixed(3) + ',' + middle[1].toFixed(3) + ',' + middle[2].toFixed(3);
    const onSideFace = Math.abs(Math.abs(middle[1]) - shape.thickness / 2) < 1e-6;
    const onRoot = Math.abs(middle[0]) < 1e-6;
    if (onSideFace && !onRoot && !seen.includes(key)) {
      filleter.Add(shape.edgeRadius, edge);
      seen.push(key);
      count = count + 1;
    }
    explorer.Next();
  }
  explorer.delete();
  if (count !== 6) {
    throw new Error('expected 6 fin edges to round, found ' + String(count));
  }
  filleter.Build(noProgress(oc));
  if (!filleter.IsDone()) {
    throw new Error('fin edge rounding failed');
  }
  return filleter.Shape();
}

function makeSled(): Shape {
  const halfWidth = sled.boardWidth / 2;
  const board = plateXZ(
    [
      [-halfWidth, 0],
      [halfWidth, 0],
      [halfWidth, sled.boardLength],
      [-halfWidth, sled.boardLength],
    ],
    sled.boardThickness,
  );
  const aft = cylinderAlong([0, 0, -sled.bulkheadThickness], [0, 0, 1], sled.bulkheadRadius, sled.bulkheadThickness + 0.5);
  const fore = cylinderAlong([0, 0, sled.boardLength - 0.5], [0, 0, 1], sled.bulkheadRadius, sled.bulkheadThickness + 0.5);
  return unify(fuse(fuse(board, aft), fore));
}

// The fin in rocket stations: rolled so its span is along +x of the rocket,
// root on the tube surface.
function finOnRocket(angle: number): Shape {
  const local = makeFinShape(fin);
  const moved = transformed(local, translation(body.outerRadius - 0.5, 0, rocketStations.finRootTrailing));
  return transformed(moved, rotationAboutZ(angle));
}

function makeFusedRocket(): Shape {
  const tubeSolid = revolvePolygon([
    [0, rocketStations.tubeAft],
    [body.outerRadius, rocketStations.tubeAft],
    [body.outerRadius, rocketStations.tubeFore],
    [0, rocketStations.tubeFore],
  ]);
  let rocket = fuse(solidBoattail(), tubeSolid);
  const noseSolid = transformed(solidOgive(body.outerRadius, nose.length), translation(0, 0, rocketStations.tubeFore));
  rocket = fuse(rocket, noseSolid);
  for (let i = 0; i < 4; i++) {
    rocket = fuse(rocket, finOnRocket((i * Math.PI) / 2));
  }
  return unify(rocket);
}

// ---------------------------------------------------------------------------
// Writing and checking STEP files.

function setLengthUnit(unitName: string): void {
  const ok = oc.Interface_Static.SetCVal('write.step.unit', unitName);
  if (!ok) {
    throw new Error('could not set write.step.unit to ' + unitName);
  }
}

function copyOut(virtualPath: string, fileName: string): void {
  const text = oc.FS.readFile(virtualPath, { encoding: 'utf8' }) as string;
  oc.FS.unlink(virtualPath);
  // OCCT writes the time of writing into the header. A fixed string keeps
  // regenerated files byte-identical.
  const timestampPattern = /'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'/;
  const stableText = text.replace(timestampPattern, "'2026-01-01T00:00:00'");
  writeFileSync(join(outputDirectory, fileName), stableText);
  checkRoundTrip(fileName, stableText);
  console.log('wrote ' + fileName + ' (' + String(stableText.length) + ' bytes)');
}

// Read the file back: it must be valid and every face must tessellate,
// otherwise every later check on it means nothing.
function checkRoundTrip(fileName: string, text: string): void {
  const virtualPath = '/check-' + fileName;
  oc.FS.writeFile(virtualPath, text);
  const reader = new oc.STEPControl_Reader();
  const readStatus = reader.ReadFile(virtualPath);
  oc.FS.unlink(virtualPath);
  if (readStatus !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
    throw new Error('re-read failed for ' + fileName);
  }
  reader.TransferRoots(noProgress(oc));
  const shape = reader.OneShape();
  const analyzer = new oc.BRepCheck_Analyzer(shape, true, false);
  if (!analyzer.IsValid()) {
    throw new Error('re-read shape is not valid for ' + fileName);
  }
  new oc.BRepMesh_IncrementalMesh(shape, 0.5, false, 0.5, false);
  const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let faceIndex = 0;
  while (explorer.More()) {
    const face = oc.TopoDS.Face(explorer.Current());
    const location = new oc.TopLoc_Location();
    const triangulation = oc.BRep_Tool.Triangulation(face, location, 0);
    let triangleCount = 0;
    if (triangulation !== null && triangulation !== undefined) {
      triangleCount = triangulation.NbTriangles();
    }
    if (triangleCount === 0) {
      throw new Error('face ' + String(faceIndex) + ' of ' + fileName + ' did not tessellate');
    }
    faceIndex = faceIndex + 1;
    explorer.Next();
  }
  reader.delete();
}

// Single parts are written through the XCAF document too, so the product
// gets exactly the given name (STEPControl_Writer appends a counter to it).
function writeSingle(name: string, localShape: Shape): void {
  const placement = placements[name];
  const shape = transformed(localShape, placementTransform(placement));
  let unit = 'MM';
  if (inchFiles.includes(name)) {
    unit = 'INCH';
  }
  const document = new oc.TDocStd_Document(new oc.TCollection_ExtendedString('MDTV-XCAF'));
  const shapeTool = oc.XCAFDoc_DocumentTool.ShapeTool(document.Main());
  const label = shapeTool.AddShape(shape, false, false);
  oc.TDataStd_Name.Set(label, new oc.TCollection_ExtendedString(name));
  const writer = new oc.STEPCAFControl_Writer();
  setLengthUnit(unit);
  writer.SetNameMode(true);
  const virtualPath = '/' + name + '.step';
  const ok = writer.Perform(document, virtualPath, noProgress(oc));
  if (!ok) {
    throw new Error('STEP write failed for ' + name);
  }
  copyOut(virtualPath, name + '.step');
}

interface NamedSolid {
  name: string;
  shape: Shape;
}

function writeAssembly(name: string, solids: NamedSolid[]): void {
  const placement = placementTransform(placements[name]);
  const document = new oc.TDocStd_Document(new oc.TCollection_ExtendedString('MDTV-XCAF'));
  const shapeTool = oc.XCAFDoc_DocumentTool.ShapeTool(document.Main());
  const assemblyLabel = shapeTool.NewShape();
  oc.TDataStd_Name.Set(assemblyLabel, new oc.TCollection_ExtendedString(name));
  for (let i = 0; i < solids.length; i++) {
    const partLabel = shapeTool.AddShape(solids[i].shape, false, false);
    oc.TDataStd_Name.Set(partLabel, new oc.TCollection_ExtendedString(solids[i].name));
    const componentLabel = shapeTool.AddComponent(assemblyLabel, partLabel, new oc.TopLoc_Location(placement));
    oc.TDataStd_Name.Set(componentLabel, new oc.TCollection_ExtendedString(solids[i].name + ':1'));
  }
  shapeTool.UpdateAssemblies();
  const writer = new oc.STEPCAFControl_Writer();
  setLengthUnit('MM');
  writer.SetNameMode(true);
  const virtualPath = '/' + name + '.step';
  const ok = writer.Perform(document, virtualPath, noProgress(oc));
  if (!ok) {
    throw new Error('STEP assembly write failed for ' + name);
  }
  copyOut(virtualPath, name + '.step');
}

// ---------------------------------------------------------------------------

mkdirSync(outputDirectory, { recursive: true });
const startTime = Date.now();

const noseShape = makeNose();
const tubeShape = makeTube();
const boattailShape = makeBoattail();
const sledShape = makeSled();

writeSingle('nose', noseShape);
writeSingle('tube', tubeShape);
writeSingle('can', makeCan());
writeSingle('boattail', boattailShape);
writeSingle('fin', makeFinShape(fin));
writeSingle('canard', makeFinShape(canard));
writeSingle('sled', sledShape);

// The assembly: nose, tube, boattail and sled as separate named solids, in
// their places along one rocket axis.
const tubeAft = rocketStations.tubeAft;
writeAssembly('assembly', [
  { name: 'nose cone', shape: transformed(noseShape, translation(0, 0, rocketStations.tubeFore)) },
  { name: 'body tube', shape: transformed(tubeShape, translation(0, 0, tubeAft)) },
  { name: 'boattail', shape: boattailShape },
  { name: 'avionics sled', shape: transformed(sledShape, translation(0, 0, tubeAft + 60)) },
]);

writeSingle('rocket', makeFusedRocket());

console.log('done in ' + String(Date.now() - startTime) + ' ms');
