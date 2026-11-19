// The data a part carries after import. This is what later stages (decals,
// flattening, export) consume, so every field says what it means and in which
// frame it is.
//
// All coordinates are in millimetres in the part's own frame, which is the
// frame of the STEP file it came from (OpenCascade converts the file's length
// unit to millimetres on reading). The assembly document places a part in the
// world with a RigidTransform; nothing here changes when it is moved.
//
// Everything is plain arrays and typed arrays, so a part can be sent from the
// import worker to the page by structured clone.

import type { Vec3 } from './vec3.ts';

export type SurfaceType = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'revolution' | 'freeform';

// One CAD face (a B-rep face of the solid).
export interface CadFace {
  surface: SurfaceType;
  // OpenCascade's own name for the surface type, e.g. "BSplineSurface". Kept
  // because "freeform" lumps several of them together.
  occType: string;
  // Analytic parameters where the surface has them, else null:
  //   plane:      axisOrigin = a point on the plane, axisDirection = its normal (as stored in the CAD surface, not necessarily outward)
  //   cylinder:   axis and radius
  //   cone:       axis, radius at axisOrigin, semiAngle (radians, signed: radius grows along axisDirection when positive)
  //   sphere:     axisOrigin = centre, radius
  //   torus:      axis, radius = major radius, minorRadius
  //   revolution: axis only
  axisOrigin: Vec3 | null;
  axisDirection: Vec3 | null;
  radius: number | null;
  semiAngle: number | null;
  minorRadius: number | null;
  // True for a plane, and for any other surface whose triangles all lie
  // within flatTolerance of one plane (CAD sometimes writes a flat face as a
  // B-spline).
  flat: boolean;
  // Outward unit normal of a flat face, from its triangles; null otherwise.
  flatNormal: Vec3 | null;
  // Indices into Part.edges of the edges bounding this face.
  edges: number[];
  // Area in mm², from the triangles.
  area: number;
}

// One CAD edge, discretised for display.
export interface CadEdge {
  // Polyline, xyz triples, in the part frame.
  points: Float32Array;
  // Set when the edge is (part of) a circle. span = the angle it covers,
  // radians (2 pi for a full circle).
  circle: { centre: Vec3; axis: Vec3; radius: number; span: number } | null;
}

// A place where this part can be joined to another: a flat side of its convex
// hull, or a large circular flat feature of the real geometry (see
// attach-faces.ts). Shown as a translucent patch by place on face and used as
// an attach node by stack snapping.
export interface AttachFace {
  // Outward unit normal (pointing away from the part).
  normal: Vec3;
  // Where two joined faces are made to coincide: the circle centre when the
  // face is circular, else the centroid of the outline.
  centre: Vec3;
  // Convex outline in the face plane, as points in order.
  outline: Vec3[];
  // Area of the outline, mm².
  area: number;
  // Present when the outline is a circle (within 2% of its radius).
  radius: number | null;
  // The direction in the face plane along which the outline is longest
  // (unit). Used to line a fin root up with the rocket axis.
  longDirection: Vec3;
  // 'hull' = a facet of the convex hull, 'feature' = from a circular flat face
  // of the real geometry, 'both' = the two coincide.
  source: 'hull' | 'feature' | 'both';
}

// Bounding volume hierarchy over the part's triangles, for ray casts.
// See bvh.ts.
export interface Bvh {
  // Per node: minX, minY, minZ, maxX, maxY, maxZ.
  bounds: Float32Array;
  // Per node: for a leaf, [first triangle in `order`, count]; for an inner
  // node, [index of the right child, 0] (the left child is the next node).
  nodes: Uint32Array;
  // Triangle indices, grouped so each leaf's triangles are contiguous.
  order: Uint32Array;
}

export interface Part {
  // Stable id: file name and solid number, e.g. "tube.step#0".
  id: string;
  name: string;
  fileName: string;
  // The length unit the file declared, for the user's information.
  sourceUnit: string;

  // Indexed triangle mesh. Vertices are not shared between CAD faces, so each
  // face keeps its own normals and face edges stay crisp.
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  // CAD face index of each triangle (length = indices.length / 3).
  triangleFace: Uint32Array;

  faces: CadFace[];
  edges: CadEdge[];

  // Convex hull of the vertices: points and triangles (outward winding).
  hullPoints: Float64Array;
  hullTriangles: Uint32Array;

  // Candidate faces for place on face and stack snapping, biggest first.
  attachFaces: AttachFace[];
  // The attach face DC6 guesses this part is joined by, until the user picks
  // one (index into attachFaces, or -1 if there are none).
  guessedAttachFace: number;

  bvh: Bvh;
  boundsMin: Vec3;
  boundsMax: Vec3;
}
