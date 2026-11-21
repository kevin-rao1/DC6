import { describe, expect, it } from 'vitest';
import { loadModel, loadPart } from './models.ts';
import { body, can, fin, boattail } from '../tools/test-model-dimensions.ts';
import { dot, length, sub } from '../src/geometry/vec3.ts';
import { convexHull } from '../src/geometry/hull.ts';
import type { AttachFace } from '../src/geometry/part.ts';

function discsOfRadius(faces: AttachFace[], radius: number): AttachFace[] {
  return faces.filter((f) => f.radius !== null && Math.abs(f.radius - radius) < 0.01);
}

describe('convex hull', () => {
  it('of a cube is 12 triangles with outward normals', () => {
    const points: number[] = [];
    for (let i = 0; i < 8; i++) {
      points.push(i & 1, (i >> 1) & 1, (i >> 2) & 1);
    }
    // Points inside and on faces must not appear.
    points.push(0.5, 0.5, 0.5, 0.5, 0.5, 0, 0.2, 0.7, 1);
    const hull = convexHull(points);
    expect(hull.triangles.length / 3).toBe(12);
    for (let t = 0; t < 12; t++) {
      const a = hull.triangles[3 * t];
      const b = hull.triangles[3 * t + 1];
      const c = hull.triangles[3 * t + 2];
      const pa = [points[3 * a], points[3 * a + 1], points[3 * a + 2]] as [number, number, number];
      const pb = [points[3 * b], points[3 * b + 1], points[3 * b + 2]] as [number, number, number];
      const pc = [points[3 * c], points[3 * c + 1], points[3 * c + 2]] as [number, number, number];
      const ab = sub(pb, pa);
      const ac = sub(pc, pa);
      const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]] as [number, number, number];
      const toCentre = sub([0.5, 0.5, 0.5], pa);
      expect(dot(n, toCentre)).toBeLessThan(0);
    }
  });
});

describe('attach faces', () => {
  it('offers the open end of the hollow nose as one disc of the full radius, and nothing else', async () => {
    const part = await loadPart('nose');
    // The real surface at the base is a 1.3 mm ring and there is a thread
    // inside; the hull offers one disc across the whole opening.
    expect(part.attachFaces.length).toBe(1);
    const base = part.attachFaces[0];
    expect(base.radius).not.toBeNull();
    expect(base.radius!).toBeCloseTo(body.outerRadius, 2);
    // The nose file points along -Y, so its base faces +Y.
    expect(base.normal[1]).toBeCloseTo(1, 6);
    expect(part.guessedAttachFace).toBe(0);
  });

  it('offers both tube ends as discs, and nothing along the side', async () => {
    const part = await loadPart('tube');
    expect(part.attachFaces.length).toBe(2);
    const ends = discsOfRadius(part.attachFaces, body.outerRadius);
    expect(ends.length).toBe(2);
    expect(dot(ends[0].normal, ends[1].normal)).toBeCloseTo(-1, 6);
  });

  it('offers the fin root, and guesses it as the attach face', async () => {
    const part = await loadPart('fin');
    const guess = part.attachFaces[part.guessedAttachFace];
    expect(guess.radius).toBeNull();
    // The root is the flat strip root chord x thickness.
    expect(guess.area).toBeCloseTo(fin.rootChord * fin.thickness, -1);
    // Its long direction is along the root chord: perpendicular to the sides.
    const side = part.attachFaces[0];
    // To 1e-4 rad: the outline comes from float32 mesh vertices.
    expect(Math.abs(dot(guess.longDirection, side.normal))).toBeLessThan(1e-4);
    expect(Math.abs(dot(guess.normal, side.normal))).toBeLessThan(1e-6);
    // The rounded leading edge, trailing edge and tip offer nothing.
    expect(part.attachFaces.length).toBe(3);
  });

  it('offers the can spigot end and the tip of its internals, and nothing for the thread, window or holes', async () => {
    const part = await loadPart('can');
    expect(part.attachFaces.length).toBe(2);
    const spigotEnd = discsOfRadius(part.attachFaces, can.spigotCoreRadius);
    const tip = discsOfRadius(part.attachFaces, can.ringOuterRadius);
    expect(spigotEnd.length).toBe(1);
    expect(tip.length).toBe(1);
    expect(dot(spigotEnd[0].normal, tip[0].normal)).toBeCloseTo(-1, 6);
    // The two are the spigot top and the ring at the bottom of the internals.
    const apart = dot(sub(spigotEnd[0].centre, tip[0].centre), spigotEnd[0].normal);
    expect(apart).toBeCloseTo(can.shellHeight + can.spigotLength - can.ringBottom, 3);
    expect(discsOfRadius(part.attachFaces, can.windowRadius).length).toBe(0);
  });

  it('keeps candidate counts small on every test part', async () => {
    const names = ['nose', 'tube', 'can', 'boattail', 'fin', 'canard', 'sled', 'assembly', 'rocket'];
    for (const name of names) {
      const parts = await loadModel(name);
      for (const part of parts) {
        expect(part.attachFaces.length).toBeGreaterThan(0);
        expect(part.attachFaces.length).toBeLessThanOrEqual(3);
        // Biggest first.
        for (let i = 1; i < part.attachFaces.length; i++) {
          expect(part.attachFaces[i].area).toBeLessThanOrEqual(part.attachFaces[i - 1].area);
        }
      }
    }
  });

  it('offers the boattail ends and the fused rocket base', async () => {
    const tail = await loadPart('boattail');
    expect(discsOfRadius(tail.attachFaces, boattail.foreRadius).length).toBe(1);
    expect(discsOfRadius(tail.attachFaces, boattail.aftRadius).length).toBe(1);
    const rocket = await loadPart('rocket');
    const base = rocket.attachFaces[rocket.guessedAttachFace];
    expect(base.radius).toBeCloseTo(boattail.aftRadius, 3);
  });

  it('puts every candidate on the hull side of the part (nothing sticks out past it)', async () => {
    const part = await loadPart('tube');
    for (const face of part.attachFaces) {
      let maxAbove = -Infinity;
      const count = part.positions.length / 3;
      for (let i = 0; i < count; i++) {
        const p: [number, number, number] = [part.positions[3 * i], part.positions[3 * i + 1], part.positions[3 * i + 2]];
        maxAbove = Math.max(maxAbove, dot(sub(p, face.centre), face.normal));
      }
      expect(maxAbove).toBeLessThan(1e-3);
      expect(length(face.normal)).toBeCloseTo(1, 9);
    }
  });
});
