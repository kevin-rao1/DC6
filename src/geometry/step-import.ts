// STEP bytes -> parts, faces and per-face triangles, using OpenCascade.
//
// This is the only module (with occ.ts) that talks to OpenCascade. Everything
// after it works on plain arrays, so it can be tested and reasoned about
// without the wasm module.

import type { TopAbs_ShapeEnum } from 'replicad-opencascadejs';
import type { Occ } from './occ.ts';
import { noProgress } from './occ.ts';
import type { SurfaceParams, Vec3 } from './types.ts';
import { SurfaceKind } from './types.ts';
import { readLengthUnit, solidOwners } from './step-text.ts';

import { angularDeflection, linearDeflection } from './tessellation.ts';

export interface ImportedFace {
  part: number;
  surface: SurfaceParams;
  // Tessellation of this face alone, in millimetres. Vertices on the face
  // boundary are repeated in each neighbouring face; mesh.ts welds them.
  positions: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
}

export interface ImportedPart {
  productName: string | null;
  instanceName: string | null;
}

export interface CadImport {
  fileName: string;
  sourceUnit: string;
  parts: ImportedPart[];
  faces: ImportedFace[];
  warnings: string[];
  readMs: number;
  meshMs: number;
}

type Shape = InstanceType<Occ['TopoDS_Shape']>;
type Face = InstanceType<Occ['TopoDS_Face']>;
type Adaptor = InstanceType<Occ['BRepAdaptor_Surface']>;

function pointOf(p: { X(): number; Y(): number; Z(): number }): Vec3 {
  return [p.X(), p.Y(), p.Z()];
}

function nowMs(): number {
  return performance.now();
}

// Centre and radius of the circle through three points that are equally
// spaced around it (their centroid is the centre).
function circleCentreOfThree(a: Vec3, b: Vec3, c: Vec3): { centre: Vec3; radius: number } {
  const centre: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  const dx = a[0] - centre[0];
  const dy = a[1] - centre[1];
  const dz = a[2] - centre[2];
  const radius = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return { centre: centre, radius: radius };
}

// The circle traced by u at a fixed v. For cones, tori and surfaces of
// revolution in OpenCascade, u is the angle around the axis, so this circle is
// centred on the axis.
function uCircle(adaptor: Adaptor, v: number): { centre: Vec3; radius: number } {
  const third = (2 * Math.PI) / 3;
  const a = pointOf(adaptor.Value(0, v));
  const b = pointOf(adaptor.Value(third, v));
  const c = pointOf(adaptor.Value(2 * third, v));
  return circleCentreOfThree(a, b, c);
}

function unitVector(a: Vec3, b: Vec3): Vec3 {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return [dx / length, dy / length, dz / length];
}

function emptyParams(kind: SurfaceKind, occType: string): SurfaceParams {
  return {
    kind: kind,
    occType: occType,
    axisOrigin: null,
    axisDirection: null,
    radius: null,
    semiAngle: null,
    minorRadius: null,
  };
}

// Surface type and analytic parameters of one face, in world coordinates
// (BRepAdaptor_Surface applies the face's location).
//
// The bindings do not expose gp_Cone or gp_Torus (Cone() and Torus() are typed
// "unknown"), so for those two the axis is found by evaluating the surface:
// the centres of two u-circles lie on the axis.
export function surfaceParamsOf(oc: Occ, face: Face): SurfaceParams {
  const adaptor = new oc.BRepAdaptor_Surface(face, true);
  const type = adaptor.GetType();
  const occType = String(type).replace('GeomAbs_', '');
  let params: SurfaceParams;
  if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
    params = emptyParams(SurfaceKind.Plane, occType);
    const axis = adaptor.Plane().Axis();
    params.axisOrigin = pointOf(axis.Location());
    params.axisDirection = pointOf(axis.Direction());
  } else if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
    params = emptyParams(SurfaceKind.Cylinder, occType);
    const cylinder = adaptor.Cylinder();
    const axis = cylinder.Axis();
    params.axisOrigin = pointOf(axis.Location());
    params.axisDirection = pointOf(axis.Direction());
    params.radius = cylinder.Radius();
  } else if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cone) {
    params = emptyParams(SurfaceKind.Cone, occType);
    const v1 = adaptor.FirstVParameter();
    const v2 = adaptor.LastVParameter();
    const first = uCircle(adaptor, v1);
    const second = uCircle(adaptor, v2);
    const direction = unitVector(first.centre, second.centre);
    const dx = second.centre[0] - first.centre[0];
    const dy = second.centre[1] - first.centre[1];
    const dz = second.centre[2] - first.centre[2];
    const axialDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    params.axisOrigin = first.centre;
    params.axisDirection = direction;
    params.radius = first.radius;
    params.semiAngle = Math.atan2(second.radius - first.radius, axialDistance);
  } else if (type === oc.GeomAbs_SurfaceType.GeomAbs_Sphere) {
    params = emptyParams(SurfaceKind.Sphere, occType);
    const sphere = adaptor.Sphere();
    params.axisOrigin = pointOf(sphere.Location());
    params.axisDirection = pointOf(sphere.Position().Direction());
    params.radius = sphere.Radius();
  } else if (type === oc.GeomAbs_SurfaceType.GeomAbs_Torus) {
    params = emptyParams(SurfaceKind.Torus, occType);
    const top = uCircle(adaptor, Math.PI / 2);
    const bottom = uCircle(adaptor, -Math.PI / 2);
    const equator = uCircle(adaptor, 0);
    const direction = unitVector(bottom.centre, top.centre);
    const dx = top.centre[0] - bottom.centre[0];
    const dy = top.centre[1] - bottom.centre[1];
    const dz = top.centre[2] - bottom.centre[2];
    const minor = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2;
    const middle: Vec3 = [
      (top.centre[0] + bottom.centre[0]) / 2,
      (top.centre[1] + bottom.centre[1]) / 2,
      (top.centre[2] + bottom.centre[2]) / 2,
    ];
    params.axisOrigin = middle;
    params.axisDirection = direction;
    params.minorRadius = minor;
    params.radius = equator.radius - minor;
    // Doubt: not checked on a torus whose u range is not the full circle at
    // v = +-pi/2; Value() evaluates the untrimmed surface, so it should hold.
  } else if (type === oc.GeomAbs_SurfaceType.GeomAbs_SurfaceOfRevolution) {
    params = emptyParams(SurfaceKind.Revolution, occType);
    const axis = adaptor.AxeOfRevolution();
    params.axisOrigin = pointOf(axis.Location());
    params.axisDirection = pointOf(axis.Direction());
  } else {
    // B-spline, Bezier, extrusion, offset, other.
    params = emptyParams(SurfaceKind.Freeform, occType);
  }
  adaptor.delete();
  return params;
}

function listSubShapes(oc: Occ, shape: Shape, type: TopAbs_ShapeEnum, avoid: TopAbs_ShapeEnum): Shape[] {
  const result: Shape[] = [];
  const explorer = new oc.TopExp_Explorer(shape, type, avoid);
  while (explorer.More()) {
    result.push(explorer.Current());
    explorer.Next();
  }
  explorer.delete();
  return result;
}

interface FaceTessellation {
  positions: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
}

// The hash ReplicadMeshExtractor uses to label its face groups:
// ReplicadShapeHasher.HashCode(face, INT_MAX). It includes the face's location,
// so the four placements of one fin prototype get four different hashes.
const faceHashUpperBound = 2147483647;

// Tessellate the whole shape in one call and split the result by face.
//
// Why one call: tessellating faces one at a time lets OpenCascade re-mesh a
// face on its own, and then its boundary nodes no longer match its
// neighbours' (we saw cracks along fillet edges). Meshing the whole shape once
// makes neighbouring faces share each edge's nodes.
function tessellateShape(oc: Occ, shape: Shape): Map<number, FaceTessellation> {
  const data = oc.ReplicadMeshExtractor.extract(shape, linearDeflection, angularDeflection, false);
  const buffer = oc.wasmMemory.buffer;
  // slice() copies out of wasm memory, so the arrays stay valid after delete().
  const allPositions = new Float32Array(buffer, data.getVerticesPtr(), data.getVerticesSize()).slice();
  const allNormals = new Float32Array(buffer, data.getNormalsPtr(), data.getNormalsSize()).slice();
  const allTriangles = new Uint32Array(buffer, data.getTrianglesPtr(), data.getTrianglesSize()).slice();
  // Face groups: (first index into the triangle index array, index count, face hash).
  const groups = new Int32Array(buffer, data.getFaceGroupsPtr(), data.getFaceGroupsSize()).slice();
  data.delete();

  const result = new Map<number, FaceTessellation>();
  const groupCount = groups.length / 3;
  for (let g = 0; g < groupCount; g++) {
    const first = groups[3 * g];
    const count = groups[3 * g + 1];
    const hash = groups[3 * g + 2];
    // Renumber the vertices this face uses, in order of first use.
    const localIndex = new Map<number, number>();
    const triangles = new Uint32Array(count);
    const usedVertices: number[] = [];
    for (let k = 0; k < count; k++) {
      const vertex = allTriangles[first + k];
      let local = localIndex.get(vertex);
      if (local === undefined) {
        local = usedVertices.length;
        localIndex.set(vertex, local);
        usedVertices.push(vertex);
      }
      triangles[k] = local;
    }
    const positions = new Float32Array(usedVertices.length * 3);
    const normals = new Float32Array(usedVertices.length * 3);
    for (let i = 0; i < usedVertices.length; i++) {
      const vertex = usedVertices[i];
      for (let axis = 0; axis < 3; axis++) {
        positions[3 * i + axis] = allPositions[3 * vertex + axis];
        normals[3 * i + axis] = allNormals[3 * vertex + axis];
      }
    }
    if (result.has(hash)) {
      throw new Error('tessellateShape: two faces have the same hash ' + String(hash) + '; cannot tell their triangles apart');
    }
    result.set(hash, { positions: positions, normals: normals, triangles: triangles });
  }
  return result;
}

export function importStep(oc: Occ, bytes: Uint8Array, fileName: string): CadImport {
  const warnings: string[] = [];
  const readStart = nowMs();

  const text = new TextDecoder('latin1').decode(bytes);
  const unit = readLengthUnit(text);

  const virtualPath = '/dc6-import.step';
  oc.FS.writeFile(virtualPath, bytes);
  const reader = new oc.STEPControl_Reader();
  // Ask OpenCascade to convert whatever the file uses to millimetres.
  // (This is also the default; set it so it does not depend on that.)
  oc.Interface_Static.SetCVal('xstep.cascade.unit', 'MM');
  const readStatus = reader.ReadFile(virtualPath);
  oc.FS.unlink(virtualPath);
  if (readStatus !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
    reader.delete();
    throw new Error('This does not look like a STEP file OpenCascade can read (status ' + String(readStatus) + ').');
  }
  const rootCount = reader.TransferRoots(noProgress(oc));
  if (rootCount === 0) {
    reader.delete();
    throw new Error('The STEP file has no shapes in it.');
  }
  const shape = reader.OneShape();
  const readEnd = nowMs();

  // Parts are solids. A file with no solids (a surface model) becomes shells,
  // and failing that one part holding every face.
  let partShapes = listSubShapes(oc, shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  const looseFaces = listSubShapes(oc, shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SOLID);
  if (partShapes.length === 0) {
    partShapes = listSubShapes(oc, shape, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    if (partShapes.length > 0) {
      warnings.push('The file has no solids; each shell is treated as a part.');
    }
  } else if (looseFaces.length > 0) {
    warnings.push(String(looseFaces.length) + ' faces are not part of any solid and were ignored.');
  }
  if (partShapes.length === 0) {
    partShapes = [shape];
    warnings.push('The file has no solids or shells; all faces are treated as one part.');
  }

  // Names from the STEP text, matched by order.
  const owners = solidOwners(text);
  const parts: ImportedPart[] = [];
  const namesMatch = owners.length === partShapes.length;
  if (!namesMatch && owners.length > 0) {
    warnings.push(
      'Part names could not be matched to the solids (' +
        String(owners.length) +
        ' named, ' +
        String(partShapes.length) +
        ' solids), so parts are numbered instead.',
    );
  }
  for (let i = 0; i < partShapes.length; i++) {
    if (namesMatch) {
      parts.push({ productName: owners[i].productName, instanceName: owners[i].instanceName });
    } else {
      parts.push({ productName: null, instanceName: null });
    }
  }

  // Tessellate the whole shape once, so that faces sharing an edge share the
  // edge's discretisation (their boundary vertices coincide and can be welded).
  const meshStart = nowMs();
  const tessellations = tessellateShape(oc, shape);

  const faces: ImportedFace[] = [];
  let emptyFaceCount = 0;
  for (let p = 0; p < partShapes.length; p++) {
    const faceShapes = listSubShapes(oc, partShapes[p], oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (let f = 0; f < faceShapes.length; f++) {
      const face = oc.TopoDS.Face(faceShapes[f]);
      const surface = surfaceParamsOf(oc, face);
      const hash = oc.ReplicadShapeHasher.HashCode(face, faceHashUpperBound);
      let tessellation = tessellations.get(hash);
      if (tessellation === undefined) {
        // A face with no triangulation has no group at all.
        tessellation = { positions: new Float32Array(0), normals: new Float32Array(0), triangles: new Uint32Array(0) };
      }
      if (tessellation.triangles.length === 0) {
        emptyFaceCount = emptyFaceCount + 1;
      }
      faces.push({
        part: p,
        surface: surface,
        positions: tessellation.positions,
        normals: tessellation.normals,
        triangles: tessellation.triangles,
      });
    }
  }
  if (emptyFaceCount > 0) {
    warnings.push(String(emptyFaceCount) + ' faces could not be tessellated and will be missing from the view.');
  }
  const meshEnd = nowMs();
  reader.delete();

  return {
    fileName: fileName,
    sourceUnit: unit.name,
    parts: parts,
    faces: faces,
    warnings: warnings,
    readMs: readEnd - readStart,
    meshMs: meshEnd - meshStart,
  };
}
