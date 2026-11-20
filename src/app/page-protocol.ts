// Messages between the window and the page worker (page-worker.ts).
//
// The page is built from the surface of the visible parts. A part's mesh is
// sent to the worker once (under a key the window gives it) and kept there;
// each build then sends only where each part is.

import type { Bvh, CadFace } from '../geometry/part.ts';
import type { SurfaceMesh } from '../geometry/surface-mesh.ts';
import type { RigidTransform } from '../geometry/transform.ts';
import type { Page } from '../geometry/page.ts';

export interface PageWorkerPart {
  key: number;
  name: string;
  mesh: SurfaceMesh;
  bvh: Bvh;
  positions: Float32Array;
  indices: Uint32Array;
  faces: CadFace[];
  triangleFace: Uint32Array;
}

export interface PageWorkerPiece {
  placedId: string;
  key: number;
  transform: RigidTransform;
  symmetryNumber: number | null;
  onBody: boolean;
}

export interface PageRequest {
  id: number;
  // Parts the worker has not been sent yet.
  parts: PageWorkerPart[];
  pieces: PageWorkerPiece[];
}

// The page comes back without its surface (the window has it already).
export type PageResponse = { kind: 'page'; id: number; page: Page } | { kind: 'error'; id: number; message: string };
