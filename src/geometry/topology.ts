// Adjacency of the shown exterior surface: which triangle is across each edge,
// connected components, and checks that the surface is manifold and
// consistently oriented.

import type { CadFace, CadPart, ExteriorTopology, ModelMesh, PartVisibility } from './types.ts';
import { findContacts } from './contact.ts';

// Which triangles are shown, given the automatic classification and the
// user's per-part overrides.
//   auto: the faces classified exterior (inner walls of an exterior part stay hidden)
//   show: every face of the part
//   hide: none
export function includedTriangles(mesh: ModelMesh, faces: CadFace[], overrides: PartVisibility[] | null): Uint8Array {
  const triangleCount = mesh.triangleFace.length;
  const included = new Uint8Array(triangleCount);
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    let mode: PartVisibility = 'auto';
    if (overrides !== null) {
      mode = overrides[face.part];
    }
    let show = false;
    if (mode === 'auto') {
      show = face.exterior;
    } else if (mode === 'show') {
      show = true;
    }
    if (!show) {
      continue;
    }
    const end = face.triangleStart + face.triangleCount;
    for (let t = face.triangleStart; t < end; t++) {
      included[t] = 1;
    }
  }
  return included;
}

// Key of an undirected edge between welded vertices a and b.
function edgeKey(a: number, b: number, vertexCount: number): number {
  if (a < b) {
    return a * vertexCount + b;
  }
  return b * vertexCount + a;
}

export function buildTopology(mesh: ModelMesh, faces: CadFace[], included: Uint8Array): ExteriorTopology {
  const triangleCount = mesh.triangleFace.length;
  const vertexCount = mesh.positions.length / 3;
  // Doubt: edge keys are a * n + b, exact in a double up to n of about 9e7
  // vertices, far beyond any rocket.
  if (vertexCount > 90000000) {
    throw new Error('buildTopology: too many vertices for the edge key scheme');
  }
  // For each undirected edge: the (triangle * 3 + edge) slots that use it.
  const edgeUses = new Map<number, number[]>();
  for (let t = 0; t < triangleCount; t++) {
    if (included[t] === 0) {
      continue;
    }
    for (let k = 0; k < 3; k++) {
      const a = mesh.triangles[3 * t + k];
      const b = mesh.triangles[3 * t + ((k + 1) % 3)];
      const key = edgeKey(a, b, vertexCount);
      let uses = edgeUses.get(key);
      if (uses === undefined) {
        uses = [];
        edgeUses.set(key, uses);
      }
      uses.push(3 * t + k);
    }
  }

  const neighbours = new Int32Array(triangleCount * 3);
  neighbours.fill(-1);
  let nonManifold = 0;
  let inconsistent = 0;
  for (const uses of edgeUses.values()) {
    if (uses.length === 2) {
      const slot0 = uses[0];
      const slot1 = uses[1];
      const t0 = Math.floor(slot0 / 3);
      const t1 = Math.floor(slot1 / 3);
      neighbours[slot0] = t1;
      neighbours[slot1] = t0;
      // Consistent orientation: the two triangles run along the edge in
      // opposite directions.
      const a0 = mesh.triangles[slot0];
      const a1 = mesh.triangles[slot1];
      if (a0 === a1) {
        inconsistent = inconsistent + 1;
      }
    } else if (uses.length > 2) {
      nonManifold = nonManifold + 1;
    }
  }

  // Connected components by flood fill over neighbours.
  const component = new Int32Array(triangleCount);
  component.fill(-1);
  let componentCount = 0;
  const queue: number[] = [];
  for (let seed = 0; seed < triangleCount; seed++) {
    if (included[seed] === 0 || component[seed] >= 0) {
      continue;
    }
    component[seed] = componentCount;
    queue.length = 0;
    queue.push(seed);
    let head = 0;
    while (head < queue.length) {
      const t = queue[head];
      head = head + 1;
      for (let k = 0; k < 3; k++) {
        const other = neighbours[3 * t + k];
        if (other >= 0 && component[other] < 0) {
          component[other] = componentCount;
          queue.push(other);
        }
      }
    }
    componentCount = componentCount + 1;
  }

  const topology: ExteriorTopology = {
    included: included,
    neighbours: neighbours,
    componentCount: componentCount,
    component: component,
    nonManifoldEdgeCount: nonManifold,
    inconsistentEdgeCount: inconsistent,
    contacts: [],
  };
  topology.contacts = findContacts(mesh, faces, topology);
  return topology;
}

// Edge-count check for one part: every edge of the part's triangles used by
// exactly two of them means the part's tessellation is closed (watertight).
// Counts only that part's triangles, so a weld with a touching part does not
// count against it. Returns the number of open (single-use) edges.
export function openEdgeCountOfPart(mesh: ModelMesh, faces: CadFace[], part: CadPart): number {
  const vertexCount = mesh.positions.length / 3;
  const counts = new Map<number, number>();
  for (let k = 0; k < part.faceIds.length; k++) {
    const face = faces[part.faceIds[k]];
    const end = face.triangleStart + face.triangleCount;
    for (let t = face.triangleStart; t < end; t++) {
      for (let e = 0; e < 3; e++) {
        const a = mesh.triangles[3 * t + e];
        const b = mesh.triangles[3 * t + ((e + 1) % 3)];
        const key = edgeKey(a, b, vertexCount);
        const previous = counts.get(key);
        if (previous === undefined) {
          counts.set(key, 1);
        } else {
          counts.set(key, previous + 1);
        }
      }
    }
  }
  let open = 0;
  for (const count of counts.values()) {
    if (count === 1) {
      open = open + 1;
    }
  }
  return open;
}
