// Boolean operations on flat polygons, for knocking out overlapping vinyl
// colours (a lower colour has the parts covered by higher colours removed).
//
// The method is the plain one, chosen to be easy to check rather than fast:
//   1. take every edge of every input ring;
//   2. split edges where they cross or touch each other;
//   3. keep a piece of edge when the result region is on exactly one side of
//      it (tested at points just left and right of its middle, with each
//      input's own fill rule), turned so the region is on its left;
//   4. join the kept pieces end to end into closed rings.
// Overlapping or self-intersecting inputs, holes, and both fill rules come
// out right because step 3 asks the region itself, not the edge's origin.
// Cost is roughly (edges) x (edges near each edge); decal artwork flattened
// to 0.01 mm has a few thousand edges, which takes milliseconds.

import type { FillRule, Point2 } from './artwork.ts';

export type Ring = Point2[];

export interface Region {
  rings: Ring[];
  rule: FillRule;
}

interface Edge {
  a: Point2;
  b: Point2;
}

// Edges of a region, bucketed by height, for fast point-in-region tests.
interface Bucketed {
  rule: FillRule;
  minY: number;
  bandHeight: number;
  bands: Edge[][];
}

const bandCount = 64;

function bucket(region: Region): Bucketed {
  let minY = Infinity;
  let maxY = -Infinity;
  const edges: Edge[] = [];
  for (let r = 0; r < region.rings.length; r++) {
    const ring = region.rings[r];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      edges.push({ a: a, b: b });
      minY = Math.min(minY, a[1]);
      maxY = Math.max(maxY, a[1]);
    }
  }
  const bands: Edge[][] = [];
  for (let k = 0; k < bandCount; k++) {
    bands.push([]);
  }
  let bandHeight = (maxY - minY) / bandCount;
  if (!(bandHeight > 0)) {
    bandHeight = 1;
  }
  for (let i = 0; i < edges.length; i++) {
    const low = Math.min(edges[i].a[1], edges[i].b[1]);
    const high = Math.max(edges[i].a[1], edges[i].b[1]);
    const first = Math.max(0, Math.floor((low - minY) / bandHeight));
    const last = Math.min(bandCount - 1, Math.floor((high - minY) / bandHeight));
    for (let k = first; k <= last; k++) {
      bands[k].push(edges[i]);
    }
  }
  return { rule: region.rule, minY: minY, bandHeight: bandHeight, bands: bands };
}

// Winding number of the region's rings around p, then the fill rule.
function insideBucketed(region: Bucketed, p: Point2): boolean {
  const band = Math.floor((p[1] - region.minY) / region.bandHeight);
  if (band < 0 || band >= bandCount) {
    return false;
  }
  const edges = region.bands[band];
  let winding = 0;
  for (let i = 0; i < edges.length; i++) {
    const a = edges[i].a;
    const b = edges[i].b;
    // Half-open in y, so a vertex is counted once.
    if (a[1] <= p[1]) {
      if (b[1] > p[1]) {
        const side = (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]);
        if (side > 0) {
          winding = winding + 1;
        }
      }
    } else if (b[1] <= p[1]) {
      const side = (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]);
      if (side < 0) {
        winding = winding - 1;
      }
    }
  }
  if (region.rule === 'evenodd') {
    return winding % 2 !== 0;
  }
  return winding !== 0;
}

export function insideRegion(region: Region, p: Point2): boolean {
  return insideBucketed(bucket(region), p);
}

interface SplitEdge {
  a: Point2;
  b: Point2;
  minX: number;
  maxX: number;
  // Split points along the edge: parameter and the shared point.
  splits: Array<{ t: number; point: Point2 }>;
}

// Record where edges e and f cross or touch.
function intersectEdges(e: SplitEdge, f: SplitEdge): void {
  const rx = e.b[0] - e.a[0];
  const ry = e.b[1] - e.a[1];
  const sx = f.b[0] - f.a[0];
  const sy = f.b[1] - f.a[1];
  const denominator = rx * sy - ry * sx;
  const qx = f.a[0] - e.a[0];
  const qy = f.a[1] - e.a[1];
  const eLength2 = rx * rx + ry * ry;
  const fLength2 = sx * sx + sy * sy;
  if (eLength2 === 0 || fLength2 === 0) {
    return;
  }
  const parallelTolerance = 1e-12 * Math.sqrt(eLength2 * fLength2);
  if (Math.abs(denominator) <= parallelTolerance) {
    // Parallel. If also collinear, each edge is split at the other's ends.
    const offset = Math.abs(qx * ry - qy * rx) / Math.sqrt(eLength2);
    if (offset > 1e-9) {
      return;
    }
    addCollinearSplits(e, f);
    addCollinearSplits(f, e);
    return;
  }
  const t = (qx * sy - qy * sx) / denominator;
  const u = (qx * ry - qy * rx) / denominator;
  const slack = 1e-12;
  if (t < -slack || t > 1 + slack || u < -slack || u > 1 + slack) {
    return;
  }
  // One shared point object for both edges, so the pieces meet exactly.
  let point: Point2 = [e.a[0] + t * rx, e.a[1] + t * ry];
  if (t <= slack) {
    point = e.a;
  } else if (t >= 1 - slack) {
    point = e.b;
  } else if (u <= slack) {
    point = f.a;
  } else if (u >= 1 - slack) {
    point = f.b;
  }
  if (t > slack && t < 1 - slack) {
    e.splits.push({ t: t, point: point });
  }
  if (u > slack && u < 1 - slack) {
    f.splits.push({ t: u, point: point });
  }
}

// Split e at f's end points where they lie inside e.
function addCollinearSplits(e: SplitEdge, f: SplitEdge): void {
  const rx = e.b[0] - e.a[0];
  const ry = e.b[1] - e.a[1];
  const length2 = rx * rx + ry * ry;
  const ends = [f.a, f.b];
  for (let k = 0; k < 2; k++) {
    const t = ((ends[k][0] - e.a[0]) * rx + (ends[k][1] - e.a[1]) * ry) / length2;
    if (t > 1e-12 && t < 1 - 1e-12) {
      e.splits.push({ t: t, point: ends[k] });
    }
  }
}

function pointKey(p: Point2): string {
  const qx = Math.round(p[0] * 1e7);
  const qy = Math.round(p[1] * 1e7);
  return String(qx) + ',' + String(qy);
}

// The outline of the region where `predicate` holds, given whether a point
// is inside each input region. Rings have the region on their left (x
// right, y up), i.e. outer rings counterclockwise and holes clockwise in a
// y-up frame.
export function booleanRings(regions: Region[], predicate: (inside: boolean[]) => boolean): Ring[] {
  const bucketed: Bucketed[] = [];
  const edges: SplitEdge[] = [];
  for (let r = 0; r < regions.length; r++) {
    bucketed.push(bucket(regions[r]));
    for (let k = 0; k < regions[r].rings.length; k++) {
      const ring = regions[r].rings[k];
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        if (a[0] === b[0] && a[1] === b[1]) {
          continue;
        }
        edges.push({ a: a, b: b, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), splits: [] });
      }
    }
  }

  // Step 2: sweep along x so only edges whose x ranges overlap are compared.
  const order = edges.slice();
  order.sort(function byMinX(p, q) {
    return p.minX - q.minX;
  });
  for (let i = 0; i < order.length; i++) {
    const e = order[i];
    const eMinY = Math.min(e.a[1], e.b[1]);
    const eMaxY = Math.max(e.a[1], e.b[1]);
    for (let j = i + 1; j < order.length; j++) {
      const f = order[j];
      if (f.minX > e.maxX) {
        break;
      }
      const fMinY = Math.min(f.a[1], f.b[1]);
      const fMaxY = Math.max(f.a[1], f.b[1]);
      if (fMinY > eMaxY || fMaxY < eMinY) {
        continue;
      }
      intersectEdges(e, f);
    }
  }

  function regionAt(p: Point2): boolean {
    const flags: boolean[] = [];
    for (let r = 0; r < bucketed.length; r++) {
      flags.push(insideBucketed(bucketed[r], p));
    }
    return predicate(flags);
  }

  // Step 3: classify the pieces.
  const kept = new Map<string, { a: Point2; b: Point2 }>();
  const epsilon = 1e-5;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    e.splits.sort(function byT(p, q) {
      return p.t - q.t;
    });
    const points: Point2[] = [e.a];
    for (let k = 0; k < e.splits.length; k++) {
      points.push(e.splits[k].point);
    }
    points.push(e.b);
    for (let k = 0; k + 1 < points.length; k++) {
      const a = points[k];
      const b = points[k + 1];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (length < 1e-9) {
        continue;
      }
      const middle: Point2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const leftX = -dy / length;
      const leftY = dx / length;
      const left = regionAt([middle[0] + leftX * epsilon, middle[1] + leftY * epsilon]);
      const right = regionAt([middle[0] - leftX * epsilon, middle[1] - leftY * epsilon]);
      if (left === right) {
        continue;
      }
      let from = a;
      let to = b;
      if (right) {
        from = b;
        to = a;
      }
      // Coincident pieces from two inputs come out identical: keep one.
      const key = pointKey(from) + '>' + pointKey(to);
      if (!kept.has(key)) {
        kept.set(key, { a: from, b: to });
      }
    }
  }

  // Step 4: join pieces into rings. At a point where several pieces start,
  // take the sharpest right turn, which keeps rings that only touch at a
  // corner apart.
  const starting = new Map<string, Array<{ a: Point2; b: Point2; used: boolean }>>();
  const all: Array<{ a: Point2; b: Point2; used: boolean }> = [];
  kept.forEach(function index(piece) {
    const entry = { a: piece.a, b: piece.b, used: false };
    all.push(entry);
    const key = pointKey(piece.a);
    let list = starting.get(key);
    if (list === undefined) {
      list = [];
      starting.set(key, list);
    }
    list.push(entry);
  });
  const rings: Ring[] = [];
  for (let i = 0; i < all.length; i++) {
    if (all[i].used) {
      continue;
    }
    const ring: Ring = [];
    let current = all[i];
    const startKey = pointKey(current.a);
    let guard = 0;
    for (;;) {
      current.used = true;
      ring.push(current.a);
      const endKey = pointKey(current.b);
      if (endKey === startKey) {
        break;
      }
      const options = starting.get(endKey);
      let next: { a: Point2; b: Point2; used: boolean } | null = null;
      if (options !== undefined) {
        const inX = current.b[0] - current.a[0];
        const inY = current.b[1] - current.a[1];
        let bestTurn = Infinity;
        for (let k = 0; k < options.length; k++) {
          if (options[k].used) {
            continue;
          }
          const outX = options[k].b[0] - options[k].a[0];
          const outY = options[k].b[1] - options[k].a[1];
          const turn = Math.atan2(inX * outY - inY * outX, inX * outX + inY * outY);
          if (turn < bestTurn) {
            bestTurn = turn;
            next = options[k];
          }
        }
      }
      guard = guard + 1;
      if (next === null || guard > all.length) {
        break; // an open chain: should not happen; dropped below if too short
      }
      current = next;
    }
    if (ring.length >= 3) {
      rings.push(ring);
    }
  }
  return rings;
}

// Total area enclosed by rings (outer rings positive, holes negative, in a
// y-up frame).
export function ringsArea(rings: Ring[]): number {
  let total = 0;
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      sum = sum + a[0] * b[1] - b[0] * a[1];
    }
    total = total + sum / 2;
  }
  return total;
}
