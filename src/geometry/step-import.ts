// STEP bytes -> one raw part per solid: triangles, CAD faces with their
// surface types, CAD edges. Uses OpenCascade; build-part.ts then adds the
// convex hull, attach faces and ray-cast tree without it.

import type { TopAbs_ShapeEnum } from 'replicad-opencascadejs';
import type { Occ } from './occ.ts';
import { noProgress } from './occ.ts';
import type { CadEdge, CadFace, SurfaceType } from './part.ts';
import type { Vec3 } from './vec3.ts';
import { normalize, sub, length } from './vec3.ts';
import { readLengthUnitName, solidProductNames } from './step-text.ts';

// Tessellation. Linear deflection 0.05 mm is the largest gap between a
// triangle and the true surface: on the 66 mm tube that is a chord every
// 6 degrees, well under a pixel when the tube fills the screen, and the
// shading uses the CAD normals so the facets do not show. Angular deflection
// 0.1 rad keeps small tight curves (fillets, the nose tip) smooth.
export const linearDeflection = 0.05;
export const angularDeflection = 0.1;

export interface RawPart {
  name: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  triangleFace: Uint32Array;
  // Faces without area, flatness and normal yet (build-part.ts fills them).
  faces: CadFace[];
  edges: CadEdge[];
}

export interface StepImport {
  sourceUnit: string;
  parts: RawPart[];
}

type Shape = InstanceType<Occ['TopoDS_Shape']>;
type Face = InstanceType<Occ['TopoDS_Face']>;
type Edge = InstanceType<Occ['TopoDS_Edge']>;

function pointOf(p: { X(): number; Y(): number; Z(): number }): Vec3 {
  return [p.X(), p.Y(), p.Z()];
}

function listSubShapes(oc: Occ, shape: Shape, type: TopAbs_ShapeEnum): Shape[] {
  const result: Shape[] = [];
  const explorer = new oc.TopExp_Explorer(shape, type, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (explorer.More()) {
    result.push(explorer.Current());
    explorer.Next();
  }
  explorer.delete();
  return result;
}

// The circle through three points spaced evenly round it: centre is their mean.
function circleOfThree(a: Vec3, b: Vec3, c: Vec3): { centre: Vec3; radius: number } {
  const centre: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  return { centre: centre, radius: length(sub(a, centre)) };
}

type SurfaceAdaptor = InstanceType<Occ['BRepAdaptor_Surface']>;

// For cones and tori u is the angle about the axis, so the u-circle at a fixed
// v is centred on the axis.
function uCircle(adaptor: SurfaceAdaptor, v: number): { centre: Vec3; radius: number } {
  const third = (2 * Math.PI) / 3;
  const a = pointOf(adaptor.Value(0, v));
  const b = pointOf(adaptor.Value(third, v));
  const c = pointOf(adaptor.Value(2 * third, v));
  return circleOfThree(a, b, c);
}

function blankFace(surface: SurfaceType, occType: string): CadFace {
  return {
    surface: surface,
    occType: occType,
    axisOrigin: null,
    axisDirection: null,
    radius: null,
    semiAngle: null,
    minorRadius: null,
    flat: false,
    flatNormal: null,
    edges: [],
    area: 0,
  };
}

// Surface type and analytic parameters of a face, in the file frame
// (BRepAdaptor_Surface applies the face's location). gp_Cone and gp_Torus are
// not bound in this build, so their axes are found by evaluating the surface.
function describeFace(oc: Occ, face: Face): CadFace {
  const adaptor = new oc.BRepAdaptor_Surface(face, true);
  const type = adaptor.GetType();
  const occType = surfaceTypeName(oc, type);
  const types = oc.GeomAbs_SurfaceType;
  let result: CadFace;
  if (type === types.GeomAbs_Plane) {
    result = blankFace('plane', occType);
    const axis = adaptor.Plane().Axis();
    result.axisOrigin = pointOf(axis.Location());
    result.axisDirection = pointOf(axis.Direction());
  } else if (type === types.GeomAbs_Cylinder) {
    result = blankFace('cylinder', occType);
    const cylinder = adaptor.Cylinder();
    result.axisOrigin = pointOf(cylinder.Axis().Location());
    result.axisDirection = pointOf(cylinder.Axis().Direction());
    result.radius = cylinder.Radius();
  } else if (type === types.GeomAbs_Cone) {
    result = blankFace('cone', occType);
    const first = uCircle(adaptor, adaptor.FirstVParameter());
    const second = uCircle(adaptor, adaptor.LastVParameter());
    const along = sub(second.centre, first.centre);
    const axialDistance = length(along);
    result.axisOrigin = first.centre;
    result.axisDirection = normalize(along);
    result.radius = first.radius;
    result.semiAngle = Math.atan2(second.radius - first.radius, axialDistance);
  } else if (type === types.GeomAbs_Sphere) {
    result = blankFace('sphere', occType);
    const sphere = adaptor.Sphere();
    result.axisOrigin = pointOf(sphere.Location());
    result.axisDirection = pointOf(sphere.Position().Direction());
    result.radius = sphere.Radius();
  } else if (type === types.GeomAbs_Torus) {
    result = blankFace('torus', occType);
    const top = uCircle(adaptor, Math.PI / 2);
    const bottom = uCircle(adaptor, -Math.PI / 2);
    const equator = uCircle(adaptor, 0);
    const along = sub(top.centre, bottom.centre);
    const minor = length(along) / 2;
    result.axisOrigin = [
      (top.centre[0] + bottom.centre[0]) / 2,
      (top.centre[1] + bottom.centre[1]) / 2,
      (top.centre[2] + bottom.centre[2]) / 2,
    ];
    result.axisDirection = normalize(along);
    result.minorRadius = minor;
    result.radius = equator.radius - minor;
    // Doubt: not checked on a torus trimmed so that v = +-pi/2 is outside the
    // face; Value() evaluates the untrimmed surface, so it should still hold.
  } else if (type === types.GeomAbs_SurfaceOfRevolution) {
    result = blankFace('revolution', occType);
    const axis = adaptor.AxeOfRevolution();
    result.axisOrigin = pointOf(axis.Location());
    result.axisDirection = pointOf(axis.Direction());
  } else {
    // B-spline, Bezier, extrusion, offset and others.
    result = blankFace('freeform', occType);
  }
  adaptor.delete();
  return result;
}

function surfaceTypeName(oc: Occ, type: unknown): string {
  const types = oc.GeomAbs_SurfaceType as unknown as Record<string, unknown>;
  const keys = Object.keys(types);
  for (let i = 0; i < keys.length; i++) {
    if (types[keys[i]] === type) {
      return keys[i].replace('GeomAbs_', '');
    }
  }
  return 'Unknown';
}

// Discretise an edge for display and note whether it is a circle.
function describeEdge(oc: Occ, edge: Edge): CadEdge {
  const curve = new oc.BRepAdaptor_Curve(edge);
  const sampler = new oc.GCPnts_TangentialDeflection(curve, angularDeflection, linearDeflection, 2, 1e-9, 1e-7);
  const count = sampler.NbPoints();
  const points = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const p = sampler.Value(i + 1);
    points[3 * i] = p.X();
    points[3 * i + 1] = p.Y();
    points[3 * i + 2] = p.Z();
  }
  sampler.delete();
  let circle: CadEdge['circle'] = null;
  if (curve.GetType() === oc.GeomAbs_CurveType.GeomAbs_Circle) {
    const circ = curve.Circle();
    const span = Math.abs(curve.LastParameter() - curve.FirstParameter());
    circle = {
      centre: pointOf(circ.Location()),
      axis: pointOf(circ.Axis().Direction()),
      radius: circ.Radius(),
      span: Math.min(span, 2 * Math.PI),
    };
  }
  curve.delete();
  return { points: points, circle: circle };
}

// The hash ReplicadMeshExtractor labels its face groups with. It includes the
// face's location, so two placements of one shape get different hashes.
const hashUpperBound = 2147483647;

interface FaceTriangles {
  positions: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
}

// Tessellate a solid in one call (so neighbouring faces share each edge's
// nodes) and split the result by face hash, renumbering vertices per face.
function tessellate(oc: Occ, shape: Shape): Map<number, FaceTriangles> {
  const data = oc.ReplicadMeshExtractor.extract(shape, linearDeflection, angularDeflection, false);
  const buffer = oc.wasmMemory.buffer;
  // slice() copies out of wasm memory, so the arrays survive delete().
  const allPositions = new Float32Array(buffer, data.getVerticesPtr(), data.getVerticesSize()).slice();
  const allNormals = new Float32Array(buffer, data.getNormalsPtr(), data.getNormalsSize()).slice();
  const allTriangles = new Uint32Array(buffer, data.getTrianglesPtr(), data.getTrianglesSize()).slice();
  // Groups of three: first index into allTriangles, index count, face hash.
  const groups = new Int32Array(buffer, data.getFaceGroupsPtr(), data.getFaceGroupsSize()).slice();
  data.delete();

  const result = new Map<number, FaceTriangles>();
  const groupCount = groups.length / 3;
  for (let g = 0; g < groupCount; g++) {
    const first = groups[3 * g];
    const count = groups[3 * g + 1];
    const hash = groups[3 * g + 2];
    const localIndex = new Map<number, number>();
    const used: number[] = [];
    const triangles = new Uint32Array(count);
    for (let k = 0; k < count; k++) {
      const vertex = allTriangles[first + k];
      let local = localIndex.get(vertex);
      if (local === undefined) {
        local = used.length;
        localIndex.set(vertex, local);
        used.push(vertex);
      }
      triangles[k] = local;
    }
    const positions = new Float32Array(used.length * 3);
    const normals = new Float32Array(used.length * 3);
    for (let i = 0; i < used.length; i++) {
      for (let axis = 0; axis < 3; axis++) {
        positions[3 * i + axis] = allPositions[3 * used[i] + axis];
        normals[3 * i + axis] = allNormals[3 * used[i] + axis];
      }
    }
    if (result.has(hash)) {
      throw new Error('tessellate: two faces share the hash ' + String(hash) + '; cannot tell their triangles apart');
    }
    result.set(hash, { positions: positions, normals: normals, triangles: triangles });
  }
  return result;
}

function importSolid(oc: Occ, solid: Shape, name: string): RawPart {
  const tessellations = tessellate(oc, solid);

  // Number the edges once each (an edge is met once from each of its faces).
  // The indexed shape map is not bound in this build, so edges are told apart
  // by ReplicadShapeHasher, which ignores orientation like the map would.
  // Doubt: two different edges with the same hash would be merged; with a
  // 31-bit hash on a few thousand edges that is unlikely but not impossible.
  const edgeIndexOfHash = new Map<number, number>();
  const edges: CadEdge[] = [];
  const edgeShapes = listSubShapes(oc, solid, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
  for (let i = 0; i < edgeShapes.length; i++) {
    const hash = oc.ReplicadShapeHasher.HashCode(edgeShapes[i], hashUpperBound);
    if (edgeIndexOfHash.has(hash)) {
      continue;
    }
    edgeIndexOfHash.set(hash, edges.length);
    const edge = oc.TopoDS.Edge(edgeShapes[i]);
    if (oc.BRep_Tool.Degenerated(edge)) {
      // A degenerate edge (cone apex, sphere pole) is a point: nothing to draw.
      edges.push({ points: new Float32Array(0), circle: null });
    } else {
      edges.push(describeEdge(oc, edge));
    }
  }

  const faces: CadFace[] = [];
  const faceTriangles: FaceTriangles[] = [];
  const faceShapes = listSubShapes(oc, solid, oc.TopAbs_ShapeEnum.TopAbs_FACE);
  for (let f = 0; f < faceShapes.length; f++) {
    const face = oc.TopoDS.Face(faceShapes[f]);
    const description = describeFace(oc, face);
    const faceEdges = listSubShapes(oc, face, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
    for (let e = 0; e < faceEdges.length; e++) {
      const hash = oc.ReplicadShapeHasher.HashCode(faceEdges[e], hashUpperBound);
      const index = edgeIndexOfHash.get(hash);
      if (index !== undefined && !description.edges.includes(index)) {
        description.edges.push(index);
      }
    }
    faces.push(description);
    const hash = oc.ReplicadShapeHasher.HashCode(face, hashUpperBound);
    const triangles = tessellations.get(hash);
    if (triangles === undefined) {
      // A face that did not tessellate has no group; it shows as a hole.
      faceTriangles.push({ positions: new Float32Array(0), normals: new Float32Array(0), triangles: new Uint32Array(0) });
    } else {
      faceTriangles.push(triangles);
    }
  }

  // Concatenate the faces into one indexed mesh.
  let vertexCount = 0;
  let indexCount = 0;
  for (let f = 0; f < faceTriangles.length; f++) {
    vertexCount = vertexCount + faceTriangles[f].positions.length / 3;
    indexCount = indexCount + faceTriangles[f].triangles.length;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  const triangleFace = new Uint32Array(indexCount / 3);
  let vertexBase = 0;
  let indexBase = 0;
  for (let f = 0; f < faceTriangles.length; f++) {
    const piece = faceTriangles[f];
    positions.set(piece.positions, vertexBase * 3);
    normals.set(piece.normals, vertexBase * 3);
    for (let k = 0; k < piece.triangles.length; k++) {
      indices[indexBase + k] = piece.triangles[k] + vertexBase;
    }
    const triangleCount = piece.triangles.length / 3;
    for (let t = 0; t < triangleCount; t++) {
      triangleFace[indexBase / 3 + t] = f;
    }
    vertexBase = vertexBase + piece.positions.length / 3;
    indexBase = indexBase + piece.triangles.length;
  }

  return {
    name: name,
    positions: positions,
    normals: normals,
    indices: indices,
    triangleFace: triangleFace,
    faces: faces,
    edges: edges,
  };
}

// Part names: the product name of each solid when the file's product tree
// matches the solids, else the file name, numbered when there are several.
function partNames(text: string, solidCount: number, fileName: string): string[] {
  const baseName = fileName.replace(/\.(step|stp)$/i, '');
  const productNames = solidProductNames(text);
  const names: string[] = [];
  const matched = productNames.length === solidCount;
  for (let i = 0; i < solidCount; i++) {
    let name = '';
    if (matched) {
      name = productNames[i].trim();
    }
    // OpenCascade's own default product name says nothing about the part.
    if (name === '' || name.startsWith('Open CASCADE')) {
      name = baseName;
      if (solidCount > 1) {
        name = baseName + ' ' + String(i + 1);
      }
    }
    names.push(name);
  }
  // Two solids of one product (a patterned fin) get numbered.
  for (let i = 0; i < names.length; i++) {
    let copies = 1;
    for (let k = i + 1; k < names.length; k++) {
      if (names[k] === names[i]) {
        copies = copies + 1;
        names[k] = names[k] + ' ' + String(copies);
      }
    }
  }
  return names;
}

export function importStep(oc: Occ, bytes: Uint8Array, fileName: string): StepImport {
  const text = new TextDecoder('latin1').decode(bytes);
  const sourceUnit = readLengthUnitName(text);

  const virtualPath = '/dc6-import.step';
  oc.FS.writeFile(virtualPath, bytes);
  const reader = new oc.STEPControl_Reader();
  // Convert whatever the file uses to millimetres. (Also the default; set it
  // so it does not depend on that.)
  oc.Interface_Static.SetCVal('xstep.cascade.unit', 'MM');
  const status = reader.ReadFile(virtualPath);
  oc.FS.unlink(virtualPath);
  if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
    reader.delete();
    throw new Error(fileName + ' is not a STEP file OpenCascade can read.');
  }
  reader.TransferRoots(noProgress(oc));
  const shape = reader.OneShape();
  reader.delete();

  let solids = listSubShapes(oc, shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID);
  if (solids.length === 0) {
    // A surface model: each shell is a part, failing that the whole thing.
    solids = listSubShapes(oc, shape, oc.TopAbs_ShapeEnum.TopAbs_SHELL);
  }
  if (solids.length === 0) {
    solids = [shape];
  }
  const names = partNames(text, solids.length, fileName);
  const parts: RawPart[] = [];
  for (let i = 0; i < solids.length; i++) {
    const part = importSolid(oc, solids[i], names[i]);
    if (part.indices.length > 0) {
      parts.push(part);
    }
  }
  if (parts.length === 0) {
    throw new Error(fileName + ' has no shapes that could be tessellated.');
  }
  return { sourceUnit: sourceUnit, parts: parts };
}
