// Repeated parts around the axis: fins and canards.
//
// Works from geometry only, so it is the same for an assembly (each fin a
// separate solid) and for a single fused solid (fins are just faces):
//  1. Take the exterior faces that are not axisymmetric (fin sides, fin edges,
//     root fillets, canards...).
//  2. Group them into connected groups: faces that share a mesh edge are in
//     the same group. In an assembly a fin's faces are connected through the
//     fin's own edges; in a fused solid also through the fillets.
//  3. Compare groups. Two groups are candidates if their area, station of
//     centroid and radius of centroid agree. A candidate pair is confirmed by
//     rotating sample points of one group about the axis by the difference in
//     roll and checking that they land on the other group's surface.
//  4. Confirmed pairs are joined into sets. A set of N >= 2 is reported, with
//     each member's roll angle and the rotation from the first member.
//
// Naming: if every member of a set is exactly one part and the parts share a
// product name, the set takes that name ("fin"). Otherwise the sets are named
// by position: a set whose centroid is in the aft half of the rocket is "fin",
// in the forward half "canard" (with a number if there are several).
// Doubt: that is a guess about how rockets are built; it is only a label.
//
// Doubts:
//  - Mirror-image instances (a left and a right handed fin) are not matched.
//  - A fin made of faces that are not connected by mesh edges (e.g. a fin
//    pushed through the tube as two separate pieces) would be two groups.

import type { CadFace, CadPart, ExteriorTopology, InstanceMember, InstanceSet, ModelMesh, RocketAxis, Vec3 } from './types.ts';
import { cylindricalCoordinates } from './axis.ts';
import { buildBvh, closestTriangle } from './bvh.ts';
import { rotationAboutLine, transformPoint } from './vec3.ts';

export const instanceRules = {
  areaTolerance: 0.02, // relative
  stationTolerance: 1.0, // mm
  radiusTolerance: 1.0, // mm
  // Rotated sample points must land within this distance of the other group's
  // triangles. Two tessellations of the same surface differ by up to two
  // deflections; allow more.
  surfaceTolerance: 0.25, // mm
  // Fraction of sample points that must land within surfaceTolerance. Not 1:
  // CAD fillets are not always built identically on every fin. On the fused
  // test rocket OpenCascade made the corners of one fin's root fillet differ
  // by up to 2.7 mm from the other three, which affects about 2.5% of samples;
  // the fin is still, for every purpose here, an instance of the others.
  matchingFraction: 0.95,
  spacingToleranceDegrees: 0.5,
  maxSamplePoints: 400,
};

export interface FaceGroup {
  faceIds: number[];
  area: number;
  station: number;
  radius: number;
  roll: number;
  stationMin: number;
  stationMax: number;
  triangleIds: number[];
  rollDegrees: number; // filled in when the group is put in a set
}

class UnionFind {
  parent: Int32Array;

  constructor(size: number) {
    this.parent = new Int32Array(size);
    for (let i = 0; i < size; i++) {
      this.parent[i] = i;
    }
  }

  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) {
      root = this.parent[root];
    }
    // Path compression.
    let node = i;
    while (this.parent[node] !== root) {
      const next = this.parent[node];
      this.parent[node] = root;
      node = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) {
      // Keep the smaller index as root so results do not depend on call order.
      if (ra < rb) {
        this.parent[rb] = ra;
      } else {
        this.parent[ra] = rb;
      }
    }
  }
}

function groupCandidateFaces(mesh: ModelMesh, faces: CadFace[], topology: ExteriorTopology): number[][] {
  const isCandidate = new Uint8Array(faces.length);
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    if (face.triangleCount === 0) {
      continue;
    }
    const shown = topology.included[face.triangleStart] === 1;
    if (shown && !face.axisymmetric) {
      isCandidate[f] = 1;
    }
  }
  const unionFind = new UnionFind(faces.length);
  const triangleCount = mesh.triangleFace.length;
  for (let t = 0; t < triangleCount; t++) {
    const faceA = mesh.triangleFace[t];
    if (isCandidate[faceA] === 0) {
      continue;
    }
    for (let k = 0; k < 3; k++) {
      const other = topology.neighbours[3 * t + k];
      if (other < 0) {
        continue;
      }
      const faceB = mesh.triangleFace[other];
      if (faceB !== faceA && isCandidate[faceB] === 1) {
        unionFind.union(faceA, faceB);
      }
    }
  }
  const groupsByRoot = new Map<number, number[]>();
  for (let f = 0; f < faces.length; f++) {
    if (isCandidate[f] === 0) {
      continue;
    }
    const root = unionFind.find(f);
    let list = groupsByRoot.get(root);
    if (list === undefined) {
      list = [];
      groupsByRoot.set(root, list);
    }
    list.push(f);
  }
  const groups: number[][] = [];
  for (const list of groupsByRoot.values()) {
    groups.push(list);
  }
  return groups;
}

function describeGroup(mesh: ModelMesh, faces: CadFace[], faceIds: number[], axis: RocketAxis): FaceGroup {
  let area = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let stationMin = Infinity;
  let stationMax = -Infinity;
  const triangleIds: number[] = [];
  const p = mesh.positions;
  for (let i = 0; i < faceIds.length; i++) {
    const face = faces[faceIds[i]];
    const end = face.triangleStart + face.triangleCount;
    for (let t = face.triangleStart; t < end; t++) {
      triangleIds.push(t);
      const a = mesh.triangles[3 * t];
      const b = mesh.triangles[3 * t + 1];
      const c = mesh.triangles[3 * t + 2];
      const abx = p[3 * b] - p[3 * a];
      const aby = p[3 * b + 1] - p[3 * a + 1];
      const abz = p[3 * b + 2] - p[3 * a + 2];
      const acx = p[3 * c] - p[3 * a];
      const acy = p[3 * c + 1] - p[3 * a + 1];
      const acz = p[3 * c + 2] - p[3 * a + 2];
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      const triangleArea = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
      area = area + triangleArea;
      cx = cx + (triangleArea * (p[3 * a] + p[3 * b] + p[3 * c])) / 3;
      cy = cy + (triangleArea * (p[3 * a + 1] + p[3 * b + 1] + p[3 * c + 1])) / 3;
      cz = cz + (triangleArea * (p[3 * a + 2] + p[3 * b + 2] + p[3 * c + 2])) / 3;
      const corners = [a, b, c];
      for (let k = 0; k < 3; k++) {
        const v = corners[k];
        const point: Vec3 = [p[3 * v], p[3 * v + 1], p[3 * v + 2]];
        const station = cylindricalCoordinates(axis, point).station;
        if (station < stationMin) {
          stationMin = station;
        }
        if (station > stationMax) {
          stationMax = station;
        }
      }
    }
  }
  const centroid: Vec3 = [cx / area, cy / area, cz / area];
  const coordinates = cylindricalCoordinates(axis, centroid);
  return {
    faceIds: faceIds,
    area: area,
    station: coordinates.station,
    radius: coordinates.radius,
    roll: coordinates.roll,
    stationMin: stationMin,
    stationMax: stationMax,
    triangleIds: triangleIds,
    rollDegrees: (coordinates.roll * 180) / Math.PI,
  };
}

// Do the vertices of group a, rotated by `angle` about the axis, lie on group b?
function rotatesOnto(mesh: ModelMesh, a: FaceGroup, b: FaceGroup, axis: RocketAxis, angle: number): boolean {
  const bvh = buildBvh(mesh.positions, mesh.triangles, Int32Array.from(b.triangleIds));
  const rotation = rotationAboutLine(axis.origin, axis.direction, angle);
  // Sample vertices of a: every k-th triangle's first corner.
  let stride = 1;
  if (a.triangleIds.length > instanceRules.maxSamplePoints) {
    stride = Math.ceil(a.triangleIds.length / instanceRules.maxSamplePoints);
  }
  let tested = 0;
  let landed = 0;
  for (let i = 0; i < a.triangleIds.length; i = i + stride) {
    const t = a.triangleIds[i];
    const v = mesh.triangles[3 * t];
    const point: Vec3 = [mesh.positions[3 * v], mesh.positions[3 * v + 1], mesh.positions[3 * v + 2]];
    const moved = transformPoint(rotation, point);
    const hit = closestTriangle(bvh, moved[0], moved[1], moved[2], instanceRules.surfaceTolerance, null, -1);
    tested = tested + 1;
    if (hit !== null) {
      landed = landed + 1;
    }
  }
  if (tested === 0) {
    return false;
  }
  return landed >= instanceRules.matchingFraction * tested;
}

function partsOfFaces(faces: CadFace[], faceIds: number[]): number[] {
  const set = new Set<number>();
  for (let i = 0; i < faceIds.length; i++) {
    set.add(faces[faceIds[i]].part);
  }
  const list = Array.from(set);
  list.sort(function ascending(a, b) {
    return a - b;
  });
  return list;
}

// Exported for debugging and tests.
export function candidateGroups(mesh: ModelMesh, faces: CadFace[], topology: ExteriorTopology, axis: RocketAxis): FaceGroup[] {
  const faceGroups = groupCandidateFaces(mesh, faces, topology);
  const groups: FaceGroup[] = [];
  for (let i = 0; i < faceGroups.length; i++) {
    groups.push(describeGroup(mesh, faces, faceGroups[i], axis));
  }
  return groups;
}

export function detectInstances(
  mesh: ModelMesh,
  faces: CadFace[],
  parts: CadPart[],
  topology: ExteriorTopology,
  axis: RocketAxis,
): InstanceSet[] {
  const faceGroups = groupCandidateFaces(mesh, faces, topology);
  const groups: FaceGroup[] = [];
  for (let i = 0; i < faceGroups.length; i++) {
    groups.push(describeGroup(mesh, faces, faceGroups[i], axis));
  }
  // Deterministic order: by station, then roll.
  groups.sort(function byPosition(a, b) {
    if (Math.abs(a.station - b.station) > instanceRules.stationTolerance) {
      return a.station - b.station;
    }
    return a.roll - b.roll;
  });

  const unionFind = new UnionFind(groups.length);
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i];
      const b = groups[j];
      if (unionFind.find(i) === unionFind.find(j)) {
        continue;
      }
      const areaDifference = Math.abs(a.area - b.area) / Math.max(a.area, b.area);
      if (areaDifference > instanceRules.areaTolerance) {
        continue;
      }
      if (Math.abs(a.station - b.station) > instanceRules.stationTolerance) {
        continue;
      }
      if (Math.abs(a.radius - b.radius) > instanceRules.radiusTolerance) {
        continue;
      }
      const angle = b.roll - a.roll;
      // Check both ways, so a group that is a subset of the other does not match.
      if (!rotatesOnto(mesh, a, b, axis, angle)) {
        continue;
      }
      if (!rotatesOnto(mesh, b, a, axis, -angle)) {
        continue;
      }
      unionFind.union(i, j);
    }
  }

  const setsByRoot = new Map<number, FaceGroup[]>();
  for (let i = 0; i < groups.length; i++) {
    const root = unionFind.find(i);
    let list = setsByRoot.get(root);
    if (list === undefined) {
      list = [];
      setsByRoot.set(root, list);
    }
    list.push(groups[i]);
  }

  const sets: InstanceSet[] = [];
  for (const members of setsByRoot.values()) {
    if (members.length < 2) {
      continue;
    }
    // Roll in degrees, with anything within 0.05 degrees below 360 read as a
    // small negative angle, so a fin on the reference direction sorts first
    // and reads 0 rather than 360.
    for (let k = 0; k < members.length; k++) {
      let degrees = (members[k].roll * 180) / Math.PI;
      if (degrees >= 359.95) {
        degrees = degrees - 360;
      }
      members[k].rollDegrees = degrees;
    }
    members.sort(function byRoll(a, b) {
      return a.rollDegrees - b.rollDegrees;
    });
    const first = members[0];
    const instanceMembers: InstanceMember[] = [];
    for (let k = 0; k < members.length; k++) {
      const member = members[k];
      const angle = ((member.rollDegrees - first.rollDegrees) * Math.PI) / 180;
      instanceMembers.push({
        faceIds: member.faceIds.slice().sort(function ascending(a, b) {
          return a - b;
        }),
        partIds: partsOfFaces(faces, member.faceIds),
        rollDegrees: member.rollDegrees,
        transformFromFirst: rotationAboutLine(axis.origin, axis.direction, angle),
        stationMin: member.stationMin,
        stationMax: member.stationMax,
        area: member.area,
      });
    }
    // Even spacing: every gap (including the wrap-around) close to 360/N.
    const expectedGap = 360 / members.length;
    let even = true;
    for (let k = 0; k < instanceMembers.length; k++) {
      const next = instanceMembers[(k + 1) % instanceMembers.length];
      let gap = next.rollDegrees - instanceMembers[k].rollDegrees;
      if (gap <= 0) {
        gap = gap + 360;
      }
      if (Math.abs(gap - expectedGap) > instanceRules.spacingToleranceDegrees) {
        even = false;
      }
    }
    sets.push({
      name: '',
      members: instanceMembers,
      evenlySpaced: even,
    });
  }

  nameSets(sets, parts, axis);
  return sets;
}

function nameSets(sets: InstanceSet[], parts: CadPart[], axis: RocketAxis): void {
  // Sort aft to fore so names and order are stable.
  sets.sort(function byStation(a, b) {
    return a.members[0].stationMin - b.members[0].stationMin;
  });
  const middle = (axis.stationMin + axis.stationMax) / 2;
  let finCount = 0;
  let canardCount = 0;
  for (let i = 0; i < sets.length; i++) {
    const set = sets[i];
    // Product name, if every member is exactly one part, no two members are
    // the same part (in a fused solid they all are part 0), and the parts'
    // product names agree.
    let sharedName: string | null = null;
    let consistent = true;
    const usedParts = new Set<number>();
    for (let k = 0; k < set.members.length; k++) {
      const member = set.members[k];
      if (member.partIds.length !== 1 || usedParts.has(member.partIds[0])) {
        consistent = false;
        break;
      }
      usedParts.add(member.partIds[0]);
      const name = parts[member.partIds[0]].productName;
      if (name === null) {
        consistent = false;
        break;
      }
      if (sharedName === null) {
        sharedName = name;
      } else if (sharedName !== name) {
        consistent = false;
        break;
      }
    }
    if (consistent && sharedName !== null) {
      set.name = sharedName;
      continue;
    }
    const station = (set.members[0].stationMin + set.members[0].stationMax) / 2;
    if (station < middle) {
      finCount = finCount + 1;
      if (finCount === 1) {
        set.name = 'fin';
      } else {
        set.name = 'fin ' + String(finCount);
      }
    } else {
      canardCount = canardCount + 1;
      if (canardCount === 1) {
        set.name = 'canard';
      } else {
        set.name = 'canard ' + String(canardCount);
      }
    }
  }
}
