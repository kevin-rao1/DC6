// The data structures that the geometry layer produces and that later stages
// (unwrap, decals, symmetry, export) build on.
//
// Everything here is plain data: numbers, strings, arrays and typed arrays.
// No three.js, no DOM, no OpenCascade objects. A DcModel can be posted from the
// import worker to the page with structured clone.
//
// Units: millimetres everywhere, whatever the STEP file used.

export type Vec3 = [number, number, number];

// Surface types as the brief lists them (4.1).
// "freeform" covers B-spline, Bezier, extrusion, offset and anything else.
export const SurfaceKind = {
  Plane: 'plane',
  Cylinder: 'cylinder',
  Cone: 'cone',
  Sphere: 'sphere',
  Torus: 'torus',
  Revolution: 'revolution',
  Freeform: 'freeform',
} as const;
export type SurfaceKind = (typeof SurfaceKind)[keyof typeof SurfaceKind];

// The analytic description of a face's underlying surface, when OpenCascade
// has one. Fields that do not apply to the kind are null.
export interface SurfaceParams {
  kind: SurfaceKind;
  // The OpenCascade type name without the "GeomAbs_" prefix, e.g. "BSplineSurface".
  // Kept so that later stages can tell a B-spline from a Bezier inside "freeform".
  occType: string;
  // Cylinder, cone, torus, revolution: the axis. Sphere: axisOrigin is the centre.
  // Plane: axisOrigin is a point on the plane and axisDirection its normal.
  axisOrigin: Vec3 | null;
  axisDirection: Vec3 | null;
  // Cylinder: radius. Cone: radius at axisOrigin. Sphere: radius. Torus: major radius.
  radius: number | null;
  // Cone only: half angle in radians.
  semiAngle: number | null;
  // Torus only.
  minorRadius: number | null;
}

// One CAD face. Its triangles are a contiguous run in the mesh.
export interface CadFace {
  id: number;
  part: number;
  surface: SurfaceParams;
  triangleStart: number;
  triangleCount: number;
  area: number; // from the tessellation, mm^2
  // Exterior detection result (see exterior.ts).
  visibleFraction: number; // 0..1, area fraction seen from outside
  exterior: boolean; // automatic classification of the face alone
  // Set by the axis analysis: is this face a surface of revolution about the rocket axis?
  axisymmetric: boolean;
}

// One part: a solid from the STEP file (or the whole shape if the file has none).
export interface CadPart {
  id: number;
  // Display name. For assemblies: product name, made unique with a suffix when
  // the same product is used several times ("fin #2").
  name: string;
  productName: string | null; // from the STEP PRODUCT entity, null if not found
  instanceName: string | null; // from the NEXT_ASSEMBLY_USAGE_OCCURRENCE, null if not found
  faceIds: number[];
  area: number;
  exteriorAreaFraction: number; // area of exterior faces / part area
  exterior: boolean; // automatic: the part is part of the outer shell
}

// The triangle mesh of the whole model, welded so that faces of one part that
// share a CAD edge share vertices. Triangles are ordered by face.
export interface ModelMesh {
  positions: Float64Array; // 3 per vertex
  triangles: Uint32Array; // 3 vertex indices per triangle
  // Normal at each triangle corner, from the CAD surface (smooth within a face,
  // sharp across face edges). 9 per triangle.
  cornerNormals: Float32Array;
  triangleFace: Int32Array; // CAD face id of each triangle
}

// The connected exterior surface that later stages walk on (geodesics etc.).
// Rebuilt whenever the set of shown parts changes.
export interface ExteriorTopology {
  // 1 if the triangle is part of the shown exterior.
  included: Uint8Array;
  // For triangle t and edge k (from corner k to corner k+1), the exterior
  // triangle on the other side, or -1 on an open boundary.
  neighbours: Int32Array;
  // Number of connected components of the exterior and the component of each
  // triangle (-1 for triangles not included).
  componentCount: number;
  component: Int32Array;
  // Edges used by more than two exterior triangles (should be none).
  nonManifoldEdgeCount: number;
  // Exterior boundary edges whose two triangles disagree on orientation (should be none).
  inconsistentEdgeCount: number;
  // Where an open boundary of one part rests on the surface of another part
  // (a fin root on the body tube in an assembly). See contact.ts.
  contacts: ContactLink[];
}

export interface ContactLink {
  triangle: number; // exterior triangle with the open boundary edge
  edge: number; // 0..2
  otherTriangle: number; // nearest exterior triangle of the other part
  otherPart: number;
  distance: number; // mm, from the edge midpoint to the other surface
}

export interface RocketAxis {
  origin: Vec3; // a point on the axis
  direction: Vec3; // unit vector, tail to nose
  // How the direction was found.
  source: 'pca' | 'analytic-faces' | 'normal-fit' | 'user';
  // Stations (signed distance along direction from origin) of the extreme
  // exterior points: the tail end and the nose tip.
  stationMin: number;
  stationMax: number;
  // Whether the nose end is clear from the shape (a taper) or a guess.
  noseConfidence: 'clear' | 'uncertain' | 'user';
}

// One member of a repeated set (a single fin).
export interface InstanceMember {
  faceIds: number[];
  partIds: number[]; // the parts the faces belong to (one part in an assembly, the whole solid when fused)
  rollDegrees: number; // roll angle of the member's centroid about the axis, 0..360
  // Rigid transform taking the first member of the set onto this one: a rotation
  // about the rocket axis. Row-major 4x4.
  transformFromFirst: number[];
  stationMin: number;
  stationMax: number;
  area: number;
}

export interface InstanceSet {
  name: string; // "fin", "canard", or a product name from the file
  members: InstanceMember[];
  evenlySpaced: boolean; // roll spacing is 360/N within tolerance
}

export interface Timings {
  readMs: number;
  meshMs: number;
  weldMs: number;
  exteriorMs: number;
  axisMs: number;
  instancesMs: number;
  totalMs: number;
}

export interface DcModel {
  fileName: string;
  sourceUnit: string; // the length unit the STEP file declared, e.g. "millimetre", "inch"
  parts: CadPart[];
  faces: CadFace[];
  mesh: ModelMesh;
  axis: RocketAxis;
  instanceSets: InstanceSet[];
  topology: ExteriorTopology;
  // Tessellation settings used, recorded for the reader of a saved project.
  linearDeflection: number;
  angularDeflection: number;
  warnings: string[];
  timings: Timings;
}

// Per-part user override of the exterior classification.
export type PartVisibility = 'auto' | 'show' | 'hide';
