// The test rocket assembled from the separate part files the way the e2e
// script assembles it in the editor (nose left, along world -X):
//   nose - can - tube (root) - boattail, four fins on the tube at 45, 135,
//   225 and 315 degrees from straight up, 60 mm forward of the tube's aft end.
// The can's internals go into the tube (its rim meets the tube's fore end)
// and the nose screws over the can's spigot onto its shoulder.
//
// `tubeName` picks the tube file, so the same rocket can be made with the
// tube 10 mm longer.

import type { Part } from '../src/geometry/part.ts';
import type { RigidTransform } from '../src/geometry/transform.ts';
import { applyToPoint, compose, identityTransform } from '../src/geometry/transform.ts';
import { attachToSurface, mateFaces, symmetryTransforms } from '../src/geometry/mating.ts';
import type { Vec3 } from '../src/geometry/vec3.ts';
import { body, can } from '../tools/test-model-dimensions.ts';
import type { PieceInfo } from '../src/geometry/page-islands.ts';
import type { Placed } from './surfaces.ts';
import { circularFace, rootPart, surfaceOf, worldFace } from './surfaces.ts';
import { loadPart } from './models.ts';
import type { Surface } from '../src/geometry/geodesic.ts';

export interface AssembledRocket {
  placed: Placed[];
  // 1-based symmetry number per placed part (null if not in a set).
  symmetry: Array<number | null>;
  surface: Surface;
  info: PieceInfo[];
}

function moved(transform: RigidTransform, by: Vec3): RigidTransform {
  return compose({ position: by, rotation: [0, 0, 0, 1] }, transform);
}

function partCentre(part: Part): Vec3 {
  return [(part.boundsMin[0] + part.boundsMax[0]) / 2, (part.boundsMin[1] + part.boundsMax[1]) / 2, (part.boundsMin[2] + part.boundsMax[2]) / 2];
}

export function infoOf(list: Placed[], symmetry: Array<number | null>): PieceInfo[] {
  const info: PieceInfo[] = [];
  for (let i = 0; i < list.length; i++) {
    info.push({ name: list[i].part.name, faces: list[i].part.faces, triangleFace: list[i].part.triangleFace, symmetryNumber: symmetry[i] });
  }
  return info;
}

export async function assembledRocket(tubeName: string): Promise<AssembledRocket> {
  const tube = await rootPart(tubeName, null);
  tube.id = 'tube';
  // The tube's two ends.
  let fore = -1;
  let aft = -1;
  for (let f = 0; f < tube.part.attachFaces.length; f++) {
    const face = worldFace(tube, f);
    if (face.normal[0] < -0.99) {
      fore = f;
    }
    if (face.normal[0] > 0.99) {
      aft = f;
    }
  }
  if (fore < 0 || aft < 0) {
    throw new Error('expected both tube ends');
  }
  const tubeFore = worldFace(tube, fore);
  const tubeAft = worldFace(tube, aft);

  // The can: snapped by the tip of its internals, then pushed 70 mm aft.
  const canPart = await loadPart('can');
  const ring = circularFace(canPart, can.ringOuterRadius, -1);
  const canSnapped = mateFaces(canPart.attachFaces[ring], identityTransform(), tubeFore.centre, tubeFore.normal, 0);
  const canPlaced: Placed = { id: 'can', part: canPart, transform: moved(canSnapped, [can.ringBottom * -1, 0, 0]) };
  // The nose on the spigot, screwed 12 mm down onto the shoulder.
  const spigotFace = worldFace(canPlaced, circularFace(canPart, can.spigotCoreRadius, -1));
  const nosePart = await loadPart('nose');
  const noseBase = circularFace(nosePart, body.outerRadius, -1);
  const noseSnapped = mateFaces(nosePart.attachFaces[noseBase], identityTransform(), spigotFace.centre, spigotFace.normal, 0);
  const nosePlaced: Placed = { id: 'nose', part: nosePart, transform: moved(noseSnapped, [can.spigotLength, 0, 0]) };
  // The boattail on the tube's aft end.
  const boattailPart = await loadPart('boattail');
  const boattailFace = circularFace(boattailPart, body.outerRadius, -1);
  const boattailPlaced: Placed = {
    id: 'boattail',
    part: boattailPart,
    transform: mateFaces(boattailPart.attachFaces[boattailFace], identityTransform(), tubeAft.centre, tubeAft.normal, 0),
  };
  // Four fins.
  const finPart = await loadPart('fin');
  const angle = Math.PI / 4;
  const station = tubeAft.centre[0] - 60;
  const outward: Vec3 = [0, Math.sin(angle), Math.cos(angle)];
  const point: Vec3 = [station, body.outerRadius * outward[1], body.outerRadius * outward[2]];
  const first = attachToSurface(finPart.attachFaces[finPart.guessedAttachFace], partCentre(finPart), identityTransform(), point, outward, 0);
  const finTransforms = symmetryTransforms(first, 4);
  const placed: Placed[] = [nosePlaced, canPlaced, tube, boattailPlaced];
  const symmetry: Array<number | null> = [null, null, null, null];
  for (let k = 0; k < 4; k++) {
    placed.push({ id: 'fin' + String(k + 1), part: finPart, transform: finTransforms[k] });
    symmetry.push(k + 1);
  }
  return { placed: placed, symmetry: symmetry, surface: surfaceOf(placed), info: infoOf(placed, symmetry) };
}

// The one-file fused rocket, placed as the root on its base.
export async function fusedRocket(): Promise<AssembledRocket> {
  const rocket = await rootPart('rocket', null);
  const placed = [rocket];
  const symmetry: Array<number | null> = [null];
  return { placed: placed, symmetry: symmetry, surface: surfaceOf(placed), info: infoOf(placed, symmetry) };
}

export function worldPointOf(placed: Placed, local: Vec3): Vec3 {
  return applyToPoint(placed.transform, local);
}
