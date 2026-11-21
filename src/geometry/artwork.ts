// Decal artwork: the filled shapes of an imported SVG, in millimetres, ready
// to be cut from vinyl. Plain JSON-able data.
//
// Coordinates are the SVG's own orientation: x to the right, y DOWN, origin
// at the top left of the artwork's bounding box (import moves it there), so
// the artwork spans [0, width] x [0, height].
//
// Every subpath is closed (vinyl is cut along closed outlines; an open
// subpath in the SVG is filled as if closed, so it is closed here). Curves
// are kept as cubic Beziers so the cut file keeps them as curves; quadratic
// curves and elliptical arcs are converted to cubics exactly (quadratics) or
// to within far less than a micrometre (arcs, at most 90 degrees per cubic).

export type Point2 = [number, number];

export interface LineSegment {
  kind: 'line';
  to: Point2;
}

export interface CubicSegment {
  kind: 'cubic';
  c1: Point2;
  c2: Point2;
  to: Point2;
}

export type Segment = LineSegment | CubicSegment;

export interface Subpath {
  start: Point2;
  segments: Segment[];
}

export type FillRule = 'nonzero' | 'evenodd';

// One filled SVG element (path, rect, circle, ...).
export interface Shape {
  // '#rrggbb', lower case.
  colour: string;
  fillRule: FillRule;
  subpaths: Subpath[];
}

export interface Artwork {
  id: string;
  name: string;
  width: number;
  height: number;
  // In painting order: later shapes cover earlier ones.
  shapes: Shape[];
  // The distinct colours, in order of first appearance.
  colours: string[];
}

// A 2D affine map, SVG order: x' = a x + c y + e, y' = b x + d y + f.
export type Matrix2 = [number, number, number, number, number, number];

export function identityMatrix(): Matrix2 {
  return [1, 0, 0, 1, 0, 0];
}

// m * n: apply n first, then m.
export function multiplyMatrix(m: Matrix2, n: Matrix2): Matrix2 {
  const a = m[0] * n[0] + m[2] * n[1];
  const b = m[1] * n[0] + m[3] * n[1];
  const c = m[0] * n[2] + m[2] * n[3];
  const d = m[1] * n[2] + m[3] * n[3];
  const e = m[0] * n[4] + m[2] * n[5] + m[4];
  const f = m[1] * n[4] + m[3] * n[5] + m[5];
  return [a, b, c, d, e, f];
}

export function applyMatrix(m: Matrix2, p: Point2): Point2 {
  const x = m[0] * p[0] + m[2] * p[1] + m[4];
  const y = m[1] * p[0] + m[3] * p[1] + m[5];
  return [x, y];
}

// An affine map takes a Bezier curve to the Bezier curve of the mapped
// control points, so transforming a subpath is transforming its points.
export function transformSubpath(m: Matrix2, subpath: Subpath): Subpath {
  const segments: Segment[] = [];
  for (let i = 0; i < subpath.segments.length; i++) {
    const segment = subpath.segments[i];
    if (segment.kind === 'line') {
      segments.push({ kind: 'line', to: applyMatrix(m, segment.to) });
    } else {
      segments.push({ kind: 'cubic', c1: applyMatrix(m, segment.c1), c2: applyMatrix(m, segment.c2), to: applyMatrix(m, segment.to) });
    }
  }
  return { start: applyMatrix(m, subpath.start), segments: segments };
}

export function transformShape(m: Matrix2, shape: Shape): Shape {
  const subpaths: Subpath[] = [];
  for (let i = 0; i < shape.subpaths.length; i++) {
    subpaths.push(transformSubpath(m, shape.subpaths[i]));
  }
  return { colour: shape.colour, fillRule: shape.fillRule, subpaths: subpaths };
}

export interface Box2 {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function emptyBox(): Box2 {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function includePoint(box: Box2, p: Point2): void {
  box.minX = Math.min(box.minX, p[0]);
  box.minY = Math.min(box.minY, p[1]);
  box.maxX = Math.max(box.maxX, p[0]);
  box.maxY = Math.max(box.maxY, p[1]);
}

function cubicPoint(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const s = 1 - t;
  return s * s * s * p0 + 3 * s * s * t * p1 + 3 * s * t * t * p2 + t * t * t * p3;
}

// Parameters in (0, 1) where one coordinate of a cubic has a turning point
// (roots of the derivative, a quadratic).
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) {
      roots.push(-c / b);
    }
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      roots.push((-b + root) / (2 * a));
      roots.push((-b - root) / (2 * a));
    }
  }
  const inside: number[] = [];
  for (let i = 0; i < roots.length; i++) {
    if (roots[i] > 0 && roots[i] < 1) {
      inside.push(roots[i]);
    }
  }
  return inside;
}

// The exact bounding box of the shapes (curve extremes, not control points).
export function shapesBox(shapes: Shape[]): Box2 {
  const box = emptyBox();
  for (let s = 0; s < shapes.length; s++) {
    for (let k = 0; k < shapes[s].subpaths.length; k++) {
      const subpath = shapes[s].subpaths[k];
      let current = subpath.start;
      includePoint(box, current);
      for (let i = 0; i < subpath.segments.length; i++) {
        const segment = subpath.segments[i];
        includePoint(box, segment.to);
        if (segment.kind === 'cubic') {
          for (let axis = 0; axis < 2; axis++) {
            const ts = cubicExtrema(current[axis], segment.c1[axis], segment.c2[axis], segment.to[axis]);
            for (let r = 0; r < ts.length; r++) {
              const x = cubicPoint(current[0], segment.c1[0], segment.c2[0], segment.to[0], ts[r]);
              const y = cubicPoint(current[1], segment.c1[1], segment.c2[1], segment.to[1], ts[r]);
              includePoint(box, [x, y]);
            }
          }
        }
        current = segment.to;
      }
    }
  }
  return box;
}

// Flattening: curves become polylines whose distance from the curve is at
// most `tolerance` mm. Used for the knockout boolean and for tests; the
// cut file itself keeps the curves.
export function flattenSubpath(subpath: Subpath, tolerance: number): Point2[] {
  const points: Point2[] = [subpath.start];
  let current = subpath.start;
  for (let i = 0; i < subpath.segments.length; i++) {
    const segment = subpath.segments[i];
    if (segment.kind === 'line') {
      points.push(segment.to);
    } else {
      flattenCubic(current, segment.c1, segment.c2, segment.to, tolerance, points, 0);
    }
    current = segment.to;
  }
  // Closed: drop a final point that repeats the start.
  const last = points[points.length - 1];
  if (points.length > 1 && Math.abs(last[0] - points[0][0]) < 1e-12 && Math.abs(last[1] - points[0][1]) < 1e-12) {
    points.pop();
  }
  return points;
}

// Recursive halving until the control points lie within tolerance of the
// chord (the curve lies inside its control polygon, so this bounds the error).
function flattenCubic(p0: Point2, p1: Point2, p2: Point2, p3: Point2, tolerance: number, out: Point2[], depth: number): void {
  const dx = p3[0] - p0[0];
  const dy = p3[1] - p0[1];
  const chord = Math.hypot(dx, dy);
  let d1 = 0;
  let d2 = 0;
  if (chord > 1e-12) {
    d1 = Math.abs((p1[0] - p0[0]) * dy - (p1[1] - p0[1]) * dx) / chord;
    d2 = Math.abs((p2[0] - p0[0]) * dy - (p2[1] - p0[1]) * dx) / chord;
  } else {
    d1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    d2 = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
  }
  if (Math.max(d1, d2) <= tolerance || depth > 16) {
    out.push(p3);
    return;
  }
  // de Casteljau at t = 1/2.
  const p01: Point2 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  const p12: Point2 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  const p23: Point2 = [(p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2];
  const p012: Point2 = [(p01[0] + p12[0]) / 2, (p01[1] + p12[1]) / 2];
  const p123: Point2 = [(p12[0] + p23[0]) / 2, (p12[1] + p23[1]) / 2];
  const middle: Point2 = [(p012[0] + p123[0]) / 2, (p012[1] + p123[1]) / 2];
  flattenCubic(p0, p01, p012, middle, tolerance, out, depth + 1);
  flattenCubic(middle, p123, p23, p3, tolerance, out, depth + 1);
}

// Signed area of a closed polyline (positive when counterclockwise in a
// y-up frame, i.e. clockwise as drawn in SVG's y-down frame).
export function polygonArea(points: Point2[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum = sum + a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

// The map from the artwork's own frame to its frame at a set size, flipped
// as asked: what the vinyl piece is when it is applied face up.
export function sizeMatrix(artwork: Artwork, width: number, height: number, flipX: boolean, flipY: boolean): Matrix2 {
  let sx = width / artwork.width;
  let sy = height / artwork.height;
  let ex = 0;
  let ey = 0;
  if (flipX) {
    sx = -sx;
    ex = width;
  }
  if (flipY) {
    sy = -sy;
    ey = height;
  }
  return [sx, 0, 0, sy, ex, ey];
}
