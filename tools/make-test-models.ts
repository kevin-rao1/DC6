// Generates the STEP test models of brief section 6 with OpenCascade itself,
// so that the checks can run without the team's CAD.
//
// Run with:   npm run make-test-models
// Output:     test-models/*.step and test-models/manifest.json
//
// The files are checked into the repository; the tests read them and do not
// regenerate them. All dimensions are in tools/test-model-params.ts.
//
// Modelling notes, with doubts:
// - The rocket is built along +Z in a local frame (station = z) and then placed
//   in the world by a rigid transform, so that some files are off-axis.
// - The assembly files keep one fin prototype and place it four times
//   (four NEXT_ASSEMBLY_USAGE_OCCURRENCE entities referring to one PRODUCT),
//   which is how Fusion 360 and Onshape write patterned parts.
// - A fin part in the assembly carries its own root fillet. It is made by
//   fusing the fin plate with a solid tube, filleting the root edges, and then
//   cutting the tube away again, so the fin's root face is a patch of the tube
//   surface. This is what a designer gets when the fin is modelled as a
//   separate body with a fillet to the tube.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOcc, noProgress } from '../src/geometry/occ.ts';
import type { Occ } from '../src/geometry/occ.ts';
import {
  rocket,
  tubeLengthening,
  plainCylinder,
  plainCone,
  ogiveNose,
  splineBody,
  placements,
  inchModels,
} from './test-model-params.ts';
import type { Placement } from './test-model-params.ts';

type Shape = InstanceType<Occ['TopoDS_Shape']>;
type Trsf = InstanceType<Occ['gp_Trsf']>;
type Wire = InstanceType<Occ['TopoDS_Wire']>;

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

// A closed polygon in the XZ plane (x = radius, z = station), as a wire.
function polygonWireXZ(points: Array<[number, number]>): Wire {
  const wireMaker = new oc.BRepBuilderAPI_MakeWire();
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const edge = new oc.BRepBuilderAPI_MakeEdge(point(a[0], 0, a[1]), point(b[0], 0, b[1])).Edge();
    wireMaker.Add(edge);
  }
  return wireMaker.Wire();
}

// Revolve a closed XZ profile a full turn about Z.
function revolveProfile(points: Array<[number, number]>, angle: number): Shape {
  const wire = polygonWireXZ(points);
  const face = new oc.BRepBuilderAPI_MakeFace(wire, true).Face();
  const revolver = new oc.BRepPrimAPI_MakeRevol(face, zAxis(), angle, false);
  return revolver.Shape();
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

function transformed(shape: Shape, transform: Trsf): Shape {
  const transformer = new oc.BRepBuilderAPI_Transform(shape, transform, true, false);
  return transformer.Shape();
}

function rotationAboutZ(angleRadians: number): Trsf {
  const transform = new oc.gp_Trsf();
  transform.SetRotation(zAxis(), angleRadians);
  return transform;
}

function multiply(a: Trsf, b: Trsf): Trsf {
  // a * b: apply b first, then a.
  return a.Multiplied(b);
}

function countFaces(shape: Shape): number {
  const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let count = 0;
  while (explorer.More()) {
    count = count + 1;
    explorer.Next();
  }
  return count;
}

// The world placement: roll about local Z, then rotate local Z onto the
// placement axis, then translate to the placement origin.
function placementTransform(placement: Placement): Trsf {
  const ax = placement.axis[0];
  const ay = placement.axis[1];
  const az = placement.axis[2];
  const length = Math.sqrt(ax * ax + ay * ay + az * az);
  const w = [ax / length, ay / length, az / length];
  // Build an orthonormal frame (u, v, w) with w along the axis. u is chosen from
  // whichever world axis is least parallel to w.
  let helper = [1, 0, 0];
  if (Math.abs(w[0]) > 0.9) {
    helper = [0, 1, 0];
  }
  const dotHelper = helper[0] * w[0] + helper[1] * w[1] + helper[2] * w[2];
  const ux0 = helper[0] - dotHelper * w[0];
  const uy0 = helper[1] - dotHelper * w[1];
  const uz0 = helper[2] - dotHelper * w[2];
  const uLength = Math.sqrt(ux0 * ux0 + uy0 * uy0 + uz0 * uz0);
  const u = [ux0 / uLength, uy0 / uLength, uz0 / uLength];
  const v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  const o = placement.origin;
  // Columns of the rotation are the images of local X, Y, Z.
  const align = new oc.gp_Trsf();
  align.SetValues(u[0], v[0], w[0], o[0], u[1], v[1], w[1], o[1], u[2], v[2], w[2], o[2]);
  const roll = rotationAboutZ((placement.rollDegrees * Math.PI) / 180);
  return multiply(align, roll);
}

// ---------------------------------------------------------------------------
// Rocket parts in the local frame (axis +Z, station 0 at the aft end).

interface RocketLayout {
  tubeAft: number;
  tubeFore: number;
  noseTip: number;
}

function rocketLayout(tubeLength: number): RocketLayout {
  const tubeAft = rocket.boattailLength;
  const tubeFore = tubeAft + tubeLength;
  const noseTip = tubeFore + rocket.noseLength;
  return { tubeAft: tubeAft, tubeFore: tubeFore, noseTip: noseTip };
}

// Tangent ogive from (baseRadius, baseStation) to the tip on the axis.
// The profile arc has radius rho = (R^2 + L^2) / (2R), centred on the base
// plane at a distance (rho - R) on the far side of the axis.
function ogiveSolid(baseRadius: number, length: number, baseStation: number): Shape {
  const rho = (baseRadius * baseRadius + length * length) / (2 * baseRadius);
  const centreX = baseRadius - rho;
  const midStation = length / 2;
  const midX = centreX + Math.sqrt(rho * rho - midStation * midStation);
  const arc = new oc.GC_MakeArcOfCircle(
    point(baseRadius, 0, baseStation),
    point(midX, 0, baseStation + midStation),
    point(0, 0, baseStation + length),
  ).Value();
  // Written as a trimmed circle, the arc does not survive a STEP round trip in
  // this OCCT build (the re-read face has an empty v range and does not mesh).
  // An exact rational B-spline of the same arc does.
  const arcAsBSpline = oc.GeomConvert.CurveToBSplineCurve(arc, oc.Convert_ParameterisationType.Convert_TgtThetaOver2);
  const arcEdge = new oc.BRepBuilderAPI_MakeEdge(arcAsBSpline).Edge();
  const axisEdge = new oc.BRepBuilderAPI_MakeEdge(point(0, 0, baseStation + length), point(0, 0, baseStation)).Edge();
  const baseEdge = new oc.BRepBuilderAPI_MakeEdge(point(0, 0, baseStation), point(baseRadius, 0, baseStation)).Edge();
  const wireMaker = new oc.BRepBuilderAPI_MakeWire();
  wireMaker.Add(arcEdge);
  wireMaker.Add(axisEdge);
  wireMaker.Add(baseEdge);
  const face = new oc.BRepBuilderAPI_MakeFace(wireMaker.Wire(), true).Face();
  const revolver = new oc.BRepPrimAPI_MakeRevol(face, zAxis(), 2 * Math.PI, false);
  return revolver.Shape();
}

function solidTube(radius: number, aft: number, fore: number): Shape {
  return revolveProfile(
    [
      [0, aft],
      [radius, aft],
      [radius, fore],
      [0, fore],
    ],
    2 * Math.PI,
  );
}

function hollowTube(outer: number, inner: number, aft: number, fore: number): Shape {
  return revolveProfile(
    [
      [inner, aft],
      [outer, aft],
      [outer, fore],
      [inner, fore],
    ],
    2 * Math.PI,
  );
}

function solidBoattail(): Shape {
  return revolveProfile(
    [
      [0, 0],
      [rocket.tailRadius, 0],
      [rocket.bodyRadius, rocket.boattailLength],
      [0, rocket.boattailLength],
    ],
    2 * Math.PI,
  );
}

// Hollow boattail, open at the aft end. Wall thickness is the same at both ends.
function hollowBoattail(): Shape {
  return revolveProfile(
    [
      [rocket.tailInnerRadius, 0],
      [rocket.tailRadius, 0],
      [rocket.bodyRadius, rocket.boattailLength],
      [rocket.bodyInnerRadius, rocket.boattailLength],
    ],
    2 * Math.PI,
  );
}

// A flat trapezoidal plate in the plane y = 0 (x = radial, z = station),
// given thickness symmetrically in y. Points are (x, z).
function plate(points: Array<[number, number]>, thickness: number): Shape {
  const wire = polygonWireXZ(points);
  const face = new oc.BRepBuilderAPI_MakeFace(wire, true).Face();
  const shift = new oc.gp_Trsf();
  shift.SetTranslation(new oc.gp_Vec(0, -thickness / 2, 0));
  const shiftedFace = transformed(face, shift);
  const prism = new oc.BRepPrimAPI_MakePrism(shiftedFace, new oc.gp_Vec(0, thickness, 0), false, true);
  return prism.Shape();
}

function finPlate(layout: RocketLayout): Shape {
  const rootInner = rocket.bodyRadius - rocket.finRootEmbed;
  const rootTrailing = layout.tubeAft + rocket.finRootTrailingFromTubeAft;
  const rootLeading = rootTrailing + rocket.finRootChord;
  const tipX = rocket.bodyRadius + rocket.finSpan;
  const tipTrailing = rootTrailing + rocket.finTipTrailingOffset;
  const tipLeading = tipTrailing + rocket.finTipChord;
  return plate(
    [
      [rootInner, rootTrailing],
      [tipX, tipTrailing],
      [tipX, tipLeading],
      [rootInner, rootLeading],
    ],
    rocket.finThickness,
  );
}

function canardPlate(layout: RocketLayout): Shape {
  const rootInner = rocket.bodyRadius - rocket.canardRootEmbed;
  const rootLeading = layout.tubeFore - rocket.canardRootLeadingFromTubeFore;
  const rootTrailing = rootLeading - rocket.canardRootChord;
  const tipX = rocket.bodyRadius + rocket.canardSpan;
  const tipLeading = rootLeading - rocket.canardTipLeadingOffset;
  const tipTrailing = tipLeading - rocket.canardTipChord;
  const plateShape = plate(
    [
      [rootInner, rootTrailing],
      [tipX, tipTrailing],
      [tipX, tipLeading],
      [rootInner, rootLeading],
    ],
    rocket.canardThickness,
  );
  const roll = rotationAboutZ((rocket.canardRollOffsetDegrees * Math.PI) / 180);
  return transformed(plateShape, roll);
}

// Fillet the edges where the fins meet the tube. The section edges of the
// fuse are exactly the fin-tube intersection curves.
function filletSectionEdges(fuser: InstanceType<Occ['BRepAlgoAPI_Fuse']>, radius: number): Shape {
  const fused = fuser.Shape();
  const sectionEdges = fuser.SectionEdges();
  const filleter = new oc.BRepFilletAPI_MakeFillet(fused, oc.ChFi3d_FilletShape.ChFi3d_Rational);
  let edgeCount = 0;
  // NCollection_List has no index access; walk it by popping a copy.
  while (sectionEdges.Size() > 0) {
    const edgeShape = sectionEdges.First();
    filleter.Add(radius, oc.TopoDS.Edge(edgeShape));
    sectionEdges.RemoveFirst();
    edgeCount = edgeCount + 1;
  }
  if (edgeCount === 0) {
    throw new Error('expected fin root section edges to fillet');
  }
  filleter.Build(noProgress(oc));
  if (!filleter.IsDone()) {
    throw new Error('root fillet failed');
  }
  return filleter.Shape();
}

// Fuse the tube with fin plates at the given roll angles and fillet the roots.
function tubeWithFilletedFins(tube: Shape, layout: RocketLayout, rollAngles: number[]): Shape {
  const fin = finPlate(layout);
  let allFins: Shape | null = null;
  for (let i = 0; i < rollAngles.length; i++) {
    const rolled = transformed(fin, rotationAboutZ(rollAngles[i]));
    if (allFins === null) {
      allFins = rolled;
    } else {
      // The fins do not touch each other, so this "fuse" is just a compound of solids.
      allFins = fuse(allFins, rolled);
    }
  }
  if (allFins === null) {
    throw new Error('expected at least one fin');
  }
  const fuser = new oc.BRepAlgoAPI_Fuse(tube, allFins, noProgress(oc));
  return filletSectionEdges(fuser, rocket.finRootFilletRadius);
}

// One fin as a separate part with its root fillet: fuse a solid tube and one
// fin plate, fillet, then cut the solid tube away again.
function finPartWithFillet(layout: RocketLayout): Shape {
  // The cutting tube is a little longer than the fin region on both ends, but
  // does not need to be the whole tube.
  const margin = 40;
  const aft = layout.tubeAft;
  const fore = layout.tubeAft + rocket.finRootTrailingFromTubeAft + rocket.finRootChord + margin;
  const tube = solidTube(rocket.bodyRadius, aft, fore);
  const filleted = tubeWithFilletedFins(tube, layout, [0]);
  const cutter = solidTube(rocket.bodyRadius, aft - 1, fore + 1);
  return cut(filleted, cutter);
}

function finRollAngles(): number[] {
  const angles: number[] = [];
  for (let i = 0; i < rocket.finCount; i++) {
    angles.push((2 * Math.PI * i) / rocket.finCount);
  }
  return angles;
}

function canardRollAngles(): number[] {
  const angles: number[] = [];
  for (let i = 0; i < rocket.canardCount; i++) {
    angles.push((2 * Math.PI * i) / rocket.canardCount);
  }
  return angles;
}

// ---------------------------------------------------------------------------
// Writing STEP files.

function setLengthUnit(unitName: string): void {
  const ok = oc.Interface_Static.SetCVal('write.step.unit', unitName);
  if (!ok) {
    throw new Error('could not set write.step.unit to ' + unitName);
  }
}

function writeSingleShape(fileName: string, shape: Shape, unitName: string): void {
  // The writer must exist before the STEP statics can be set: creating it
  // initialises the STEP translator and its parameters.
  const writer = new oc.STEPControl_Writer();
  setLengthUnit(unitName);
  // Name the single product after the model; OCCT's default is its own name.
  const productName = fileName.replace('.step', '');
  oc.Interface_Static.SetCVal('write.step.product.name', productName);
  const transferStatus = writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true, noProgress(oc));
  if (transferStatus !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
    throw new Error('STEP transfer failed for ' + fileName);
  }
  const virtualPath = '/' + fileName;
  const writeStatus = writer.Write(virtualPath);
  if (writeStatus !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
    throw new Error('STEP write failed for ' + fileName);
  }
  copyOut(virtualPath, fileName);
}

function copyOut(virtualPath: string, fileName: string): void {
  const text = oc.FS.readFile(virtualPath, { encoding: 'utf8' }) as string;
  oc.FS.unlink(virtualPath);
  // OCCT writes the time of writing into the header. Replace it with a fixed
  // string so that regenerating the models gives byte-identical files.
  const timestampPattern = /'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'/;
  const stableText = text.replace(timestampPattern, "'2026-01-01T00:00:00'");
  writeFileSync(join(outputDirectory, fileName), stableText);
  checkRoundTrip(fileName, stableText);
  console.log('wrote ' + fileName + ' (' + stableText.length + ' bytes)');
}

// Read the file back and check that OpenCascade finds it valid and that every
// face tessellates. A test model that is itself broken would make every
// later check meaningless.
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
      throw new Error('face ' + faceIndex + ' of ' + fileName + ' did not tessellate');
    }
    faceIndex = faceIndex + 1;
    explorer.Next();
  }
}

// One part of an assembly: a named prototype shape and the places it is used.
interface AssemblyPart {
  name: string;
  shape: Shape;
  placements: Trsf[];
}

function writeAssembly(fileName: string, assemblyName: string, parts: AssemblyPart[]): void {
  const document = new oc.TDocStd_Document(new oc.TCollection_ExtendedString('MDTV-XCAF'));
  const shapeTool = oc.XCAFDoc_DocumentTool.ShapeTool(document.Main());
  const assemblyLabel = shapeTool.NewShape();
  oc.TDataStd_Name.Set(assemblyLabel, new oc.TCollection_ExtendedString(assemblyName));
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const partLabel = shapeTool.AddShape(part.shape, false, false);
    oc.TDataStd_Name.Set(partLabel, new oc.TCollection_ExtendedString(part.name));
    for (let k = 0; k < part.placements.length; k++) {
      const location = new oc.TopLoc_Location(part.placements[k]);
      const componentLabel = shapeTool.AddComponent(assemblyLabel, partLabel, location);
      const instanceName = part.name + ':' + String(k + 1);
      oc.TDataStd_Name.Set(componentLabel, new oc.TCollection_ExtendedString(instanceName));
    }
  }
  shapeTool.UpdateAssemblies();
  const writer = new oc.STEPCAFControl_Writer();
  setLengthUnit('MM');
  writer.SetNameMode(true);
  const virtualPath = '/' + fileName;
  // Perform() writes one file. Transfer() with an empty "multi" string would
  // write each part to its own external file instead.
  const ok = writer.Perform(document, virtualPath, noProgress(oc));
  if (!ok) {
    throw new Error('STEP assembly write failed for ' + fileName);
  }
  copyOut(virtualPath, fileName);
}

// ---------------------------------------------------------------------------
// The models.

function makeCylinderTwoHalves(): Shape {
  // Revolve a rectangle by half a turn, copy it rotated by half a turn, fuse.
  // The fuse removes the internal planes but keeps the two half cylinder faces.
  const half = revolveProfile(
    [
      [0, 0],
      [plainCylinder.radius, 0],
      [plainCylinder.radius, plainCylinder.length],
      [0, plainCylinder.length],
    ],
    Math.PI,
  );
  const otherHalf = transformed(half, rotationAboutZ(Math.PI));
  return fuse(half, otherHalf);
}

function makeCone(): Shape {
  return revolveProfile(
    [
      [0, 0],
      [plainCone.baseRadius, 0],
      [0, plainCone.length],
    ],
    2 * Math.PI,
  );
}

function makeSplineBody(): Shape {
  // Loft (non-ruled) through circles: OpenCascade approximates the side as one
  // B-spline face.
  const lofter = new oc.BRepOffsetAPI_ThruSections(true, false, 1e-6);
  for (let i = 0; i < splineBody.stations.length; i++) {
    const station = splineBody.stations[i];
    const radius = splineBody.radii[i];
    const frame = new oc.gp_Ax2(point(0, 0, station), new oc.gp_Dir(0, 0, 1));
    const circle = new oc.gp_Circ(frame, radius);
    const edge = new oc.BRepBuilderAPI_MakeEdge(circle).Edge();
    const wire = new oc.BRepBuilderAPI_MakeWire(edge).Wire();
    lofter.AddWire(wire);
  }
  lofter.Build(noProgress(oc));
  return lofter.Shape();
}

interface RocketParts {
  nose: Shape;
  tube: Shape;
  boattail: Shape;
  fin: Shape;
  canard: Shape;
}

function makeRocketParts(tubeLength: number, hollow: boolean): RocketParts {
  const layout = rocketLayout(tubeLength);
  const nose = ogiveSolid(rocket.bodyRadius, rocket.noseLength, layout.tubeFore);
  let tube: Shape;
  let boattail: Shape;
  if (hollow) {
    tube = hollowTube(rocket.bodyRadius, rocket.bodyInnerRadius, layout.tubeAft, layout.tubeFore);
    boattail = hollowBoattail();
  } else {
    tube = solidTube(rocket.bodyRadius, layout.tubeAft, layout.tubeFore);
    boattail = solidBoattail();
  }
  const fin = finPartWithFillet(layout);
  const canard = cut(canardPlate(layout), solidTube(rocket.bodyRadius, layout.tubeAft, layout.tubeFore));
  return { nose: nose, tube: tube, boattail: boattail, fin: fin, canard: canard };
}

function rocketAssemblyParts(tubeLength: number, hollow: boolean, placement: Placement): AssemblyPart[] {
  const world = placementTransform(placement);
  const parts = makeRocketParts(tubeLength, hollow);
  const result: AssemblyPart[] = [];
  result.push({ name: 'nose cone', shape: transformed(parts.nose, world), placements: [new oc.gp_Trsf()] });
  result.push({ name: 'body tube', shape: transformed(parts.tube, world), placements: [new oc.gp_Trsf()] });
  result.push({ name: 'boattail', shape: transformed(parts.boattail, world), placements: [new oc.gp_Trsf()] });
  // Fins and canards: the prototype stays in the local frame and each use
  // carries the full placement, as CAD patterns do.
  const finPlacements: Trsf[] = [];
  const finAngles = finRollAngles();
  for (let i = 0; i < finAngles.length; i++) {
    finPlacements.push(multiply(world, rotationAboutZ(finAngles[i])));
  }
  result.push({ name: 'fin', shape: parts.fin, placements: finPlacements });
  const canardPlacements: Trsf[] = [];
  const canardAngles = canardRollAngles();
  for (let i = 0; i < canardAngles.length; i++) {
    canardPlacements.push(multiply(world, rotationAboutZ(canardAngles[i])));
  }
  result.push({ name: 'canard', shape: parts.canard, placements: canardPlacements });
  return result;
}

function internalParts(placement: Placement): AssemblyPart[] {
  const world = placementTransform(placement);
  const motorTube = hollowTube(
    rocket.motorTubeOuterRadius,
    rocket.motorTubeInnerRadius,
    rocket.motorTubeAftStation,
    rocket.motorTubeAftStation + rocket.motorTubeLength,
  );
  // Sled: a flat board on the axis between two bulkhead discs.
  const sledAft = rocket.sledAftStation;
  const sledFore = sledAft + rocket.sledLength;
  const halfWidth = rocket.sledWidth / 2;
  const board = plate(
    [
      [-halfWidth, sledAft],
      [halfWidth, sledAft],
      [halfWidth, sledFore],
      [-halfWidth, sledFore],
    ],
    rocket.sledThickness,
  );
  const aftBulkhead = solidTube(rocket.sledBulkheadRadius, sledAft - rocket.sledBulkheadThickness, sledAft);
  const foreBulkhead = solidTube(rocket.sledBulkheadRadius, sledFore, sledFore + rocket.sledBulkheadThickness);
  const sled = fuse(fuse(board, aftBulkhead), foreBulkhead);
  const result: AssemblyPart[] = [];
  result.push({ name: 'motor tube', shape: transformed(motorTube, world), placements: [new oc.gp_Trsf()] });
  result.push({ name: 'avionics sled', shape: transformed(sled, world), placements: [new oc.gp_Trsf()] });
  return result;
}

function makeFusedRocket(tubeLength: number): Shape {
  const layout = rocketLayout(tubeLength);
  const tube = solidTube(rocket.bodyRadius, layout.tubeAft, layout.tubeFore);
  let body = tubeWithFilletedFins(tube, layout, finRollAngles());
  body = fuse(body, ogiveSolid(rocket.bodyRadius, rocket.noseLength, layout.tubeFore));
  body = fuse(body, solidBoattail());
  const canard = canardPlate(layout);
  const canardAngles = canardRollAngles();
  for (let i = 0; i < canardAngles.length; i++) {
    body = fuse(body, transformed(canard, rotationAboutZ(canardAngles[i])));
  }
  // Merge faces that the booleans split but that lie on one surface, as a CAD
  // export of a single body would have them.
  const unifier = new oc.ShapeUpgrade_UnifySameDomain(body, true, true, false);
  unifier.Build();
  return unifier.Shape();
}

// ---------------------------------------------------------------------------
// Manifest: what the tests should expect from each file.

interface ManifestEntry {
  file: string;
  description: string;
  axis: [number, number, number]; // unit vector, tail to nose
  axisPoint: [number, number, number]; // a point on the axis (station 0)
  noseKnown: boolean; // false where the shape has no nose to find
  unit: string;
  faceCount: number;
  structure: 'single' | 'assembly';
}

function unitAxis(placement: Placement): [number, number, number] {
  const a = placement.axis;
  const length = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  return [a[0] / length, a[1] / length, a[2] / length];
}

function shapeOfParts(parts: AssemblyPart[]): number {
  let count = 0;
  for (let i = 0; i < parts.length; i++) {
    count = count + countFaces(parts[i].shape) * parts[i].placements.length;
  }
  return count;
}

const manifest: ManifestEntry[] = [];

function addSingle(name: string, description: string, localShape: Shape, noseKnown: boolean): void {
  const placement = placements[name];
  const shape = transformed(localShape, placementTransform(placement));
  let unit = 'MM';
  if (inchModels.includes(name)) {
    unit = 'INCH';
  }
  writeSingleShape(name + '.step', shape, unit);
  manifest.push({
    file: name + '.step',
    description: description,
    axis: unitAxis(placement),
    axisPoint: placement.origin,
    noseKnown: noseKnown,
    unit: unit,
    faceCount: countFaces(shape),
    structure: 'single',
  });
}

function addAssembly(name: string, description: string, parts: AssemblyPart[]): void {
  const placement = placements[name];
  writeAssembly(name + '.step', 'rocket', parts);
  manifest.push({
    file: name + '.step',
    description: description,
    axis: unitAxis(placement),
    axisPoint: placement.origin,
    noseKnown: true,
    unit: 'MM',
    faceCount: shapeOfParts(parts),
    structure: 'assembly',
  });
}

mkdirSync(outputDirectory, { recursive: true });
const startTime = Date.now();

addSingle('cylinder-two-halves', 'Plain cylinder whose side is two half-cylinder faces', makeCylinderTwoHalves(), false);
addSingle('cone', 'Solid cone along +X, apex is the nose; written in inches', makeCone(), true);
addSingle(
  'ogive-nose',
  'Tangent ogive nose along -Y',
  ogiveSolid(ogiveNose.baseRadius, ogiveNose.length, 0),
  true,
);
addSingle('spline-body', 'Lofted body with a smooth spline profile (B-spline side face), off-axis', makeSplineBody(), false);

const plainParts = rocketAssemblyParts(rocket.tubeLength, false, placements['rocket-assembly']);
addAssembly('rocket-assembly', 'Rocket as an assembly: nose, tube, boattail, 4 fins with root fillets, 4 canards', plainParts);

addSingle('rocket-fused', 'The same rocket as one fused solid, off-axis', makeFusedRocket(rocket.tubeLength), true);

const internalsPlacement = placements['rocket-internals'];
const hollowParts = rocketAssemblyParts(rocket.tubeLength, true, internalsPlacement);
const withInternals = hollowParts.concat(internalParts(internalsPlacement));
addAssembly('rocket-internals', 'Hollow rocket with a motor tube and an avionics sled inside, axis +X', withInternals);

const longParts = rocketAssemblyParts(rocket.tubeLength + tubeLengthening, false, placements['rocket-long']);
addAssembly('rocket-long', 'The assembly rocket with the body tube 10 mm longer', longParts);

writeFileSync(join(outputDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('wrote manifest.json');
console.log('done in ' + String(Date.now() - startTime) + ' ms');
