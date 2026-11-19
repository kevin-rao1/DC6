// Contacts between touching parts.
//
// In an assembly the nose, tube, fins and canards are separate solids that
// only touch. A fin's exterior surface (its sides and root fillet) ends in an
// open boundary that lies on the tube's surface, but the two meshes share no
// vertices: the fin root curve runs across the middle of the tube's triangles.
//
// What this stage does: for every open boundary edge of the exterior, find the
// nearest exterior triangle of another part. If it is within contactTolerance,
// record a ContactLink. Later stages (geodesic decal mapping) can step across
// such a link from the fin fillet onto the tube and back.
//
// What it does not do: cut the tube's triangles along the fin root curve to
// make one truly connected mesh (an imprint, or a boolean union). That is the
// clean answer but is slow and fragile to do on triangles in the browser, so it
// is left until a later stage shows it is needed. Doubt: walking a geodesic
// across a contact link is approximate near the link (the two surfaces do not
// share an edge), so a decal crossing a fin root on an assembly may show a
// small kink there; on a fused single solid there is no such issue because
// OpenCascade has already imprinted the root curve.

import type { CadFace, ContactLink, ExteriorTopology, ModelMesh } from './types.ts';
import { buildBvh, closestTriangle } from './bvh.ts';
import { linearDeflection } from './tessellation.ts';

// A boundary edge midpoint on the true surface of the other part can be up to
// one tessellation deflection away from that part's triangles (chord sagitta),
// plus the same again for its own chord. Allow a little more.
export const contactTolerance = 4 * linearDeflection;

export function findContacts(mesh: ModelMesh, faces: CadFace[], topology: ExteriorTopology): ContactLink[] {
  const triangleCount = mesh.triangleFace.length;
  const trianglePart = new Int32Array(triangleCount);
  const includedIds: number[] = [];
  for (let t = 0; t < triangleCount; t++) {
    trianglePart[t] = faces[mesh.triangleFace[t]].part;
    if (topology.included[t] === 1) {
      includedIds.push(t);
    }
  }
  const contacts: ContactLink[] = [];
  if (includedIds.length === 0) {
    return contacts;
  }
  const bvh = buildBvh(mesh.positions, mesh.triangles, Int32Array.from(includedIds));
  for (let i = 0; i < includedIds.length; i++) {
    const t = includedIds[i];
    for (let k = 0; k < 3; k++) {
      if (topology.neighbours[3 * t + k] >= 0) {
        continue;
      }
      const a = mesh.triangles[3 * t + k];
      const b = mesh.triangles[3 * t + ((k + 1) % 3)];
      const mx = (mesh.positions[3 * a] + mesh.positions[3 * b]) / 2;
      const my = (mesh.positions[3 * a + 1] + mesh.positions[3 * b + 1]) / 2;
      const mz = (mesh.positions[3 * a + 2] + mesh.positions[3 * b + 2]) / 2;
      const ownPart = trianglePart[t];
      const hit = closestTriangle(bvh, mx, my, mz, contactTolerance, trianglePart, ownPart);
      if (hit === null) {
        continue;
      }
      contacts.push({
        triangle: t,
        edge: k,
        otherTriangle: hit.triangle,
        otherPart: trianglePart[hit.triangle],
        distance: hit.distance,
      });
    }
  }
  return contacts;
}
