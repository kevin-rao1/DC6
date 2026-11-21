// SVG path data and the basic shapes (rect, circle, ellipse, polygon) as
// subpaths of lines and cubic Beziers, in the element's own user units.
// Transforms are applied later by svg-import.ts.

import type { CubicSegment, Point2, Segment, Subpath } from './artwork.ts';

// Split path data into command letters and numbers. Numbers can run
// together ("1.5.5" is 1.5 and .5, "1-2" is 1 and -2), and arc flags can be
// written without separators ("a1 1 0 0110 10"), which parsePathData
// handles by reading flags one character at a time.
interface Tokens {
  text: string;
  index: number;
}

function skipSeparators(tokens: Tokens): void {
  while (tokens.index < tokens.text.length) {
    const ch = tokens.text[tokens.index];
    if (ch === ' ' || ch === ',' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f') {
      tokens.index = tokens.index + 1;
    } else {
      return;
    }
  }
}

const numberPattern = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/;

function readNumber(tokens: Tokens): number | null {
  skipSeparators(tokens);
  const rest = tokens.text.slice(tokens.index, tokens.index + 64);
  const match = numberPattern.exec(rest);
  if (match === null) {
    return null;
  }
  tokens.index = tokens.index + match[0].length;
  return Number(match[0]);
}

function readFlag(tokens: Tokens): number | null {
  skipSeparators(tokens);
  const ch = tokens.text[tokens.index];
  if (ch === '0' || ch === '1') {
    tokens.index = tokens.index + 1;
    return Number(ch);
  }
  return null;
}

function isCommand(ch: string): boolean {
  return 'MmLlHhVvCcSsQqTtAaZz'.indexOf(ch) >= 0;
}

// Builds subpaths as the commands come.
class PathBuilder {
  readonly subpaths: Subpath[] = [];
  private current: Subpath | null = null;
  point: Point2 = [0, 0];
  // Start of the current subpath (where Z returns to).
  private start: Point2 = [0, 0];

  moveTo(p: Point2): void {
    this.finish();
    this.current = { start: p, segments: [] };
    this.point = p;
    this.start = p;
  }

  // A drawing command with no subpath open (after Z) starts one at the
  // current point.
  private open(): Subpath {
    if (this.current === null) {
      this.current = { start: this.point, segments: [] };
      this.start = this.point;
    }
    return this.current;
  }

  lineTo(p: Point2): void {
    this.open().segments.push({ kind: 'line', to: p });
    this.point = p;
  }

  cubicTo(c1: Point2, c2: Point2, p: Point2): void {
    this.open().segments.push({ kind: 'cubic', c1: c1, c2: c2, to: p });
    this.point = p;
  }

  close(): void {
    this.finish();
    this.point = this.start;
  }

  // End the open subpath. Every subpath is closed: if its last point is not
  // its start, the closing line is implied (as for filling).
  finish(): void {
    const subpath = this.current;
    this.current = null;
    if (subpath === null || subpath.segments.length === 0) {
      return;
    }
    const last = subpath.segments[subpath.segments.length - 1].to;
    const gap = Math.hypot(last[0] - subpath.start[0], last[1] - subpath.start[1]);
    if (gap > 1e-9) {
      subpath.segments.push({ kind: 'line', to: [subpath.start[0], subpath.start[1]] });
    } else {
      // Snap the end exactly onto the start, so the outline closes exactly.
      const lastSegment = subpath.segments[subpath.segments.length - 1];
      lastSegment.to = [subpath.start[0], subpath.start[1]];
    }
    this.subpaths.push(subpath);
  }
}

// Parse the d attribute. Malformed data stops at the first error, keeping
// what came before, as browsers do.
export function parsePathData(d: string): Subpath[] {
  const tokens: Tokens = { text: d, index: 0 };
  const builder = new PathBuilder();
  let command = '';
  // For S and T: the previous control point, if the previous command was a
  // curve of the same family.
  let lastCubicControl: Point2 | null = null;
  let lastQuadControl: Point2 | null = null;
  for (;;) {
    skipSeparators(tokens);
    if (tokens.index >= tokens.text.length) {
      break;
    }
    const ch = tokens.text[tokens.index];
    if (isCommand(ch)) {
      command = ch;
      tokens.index = tokens.index + 1;
      if (command === 'Z' || command === 'z') {
        builder.close();
        lastCubicControl = null;
        lastQuadControl = null;
        continue;
      }
    } else if (command === '' || command === 'Z' || command === 'z') {
      break; // numbers with no command
    }
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();
    const base = builder.point;
    const ox = relative ? base[0] : 0;
    const oy = relative ? base[1] : 0;
    let ok = true;
    let nextCubic: Point2 | null = null;
    let nextQuad: Point2 | null = null;
    if (upper === 'M') {
      const x = readNumber(tokens);
      const y = readNumber(tokens);
      if (x === null || y === null) {
        break;
      }
      builder.moveTo([ox + x, oy + y]);
      // Further pairs after a moveto are linetos.
      command = relative ? 'l' : 'L';
    } else if (upper === 'L') {
      const x = readNumber(tokens);
      const y = readNumber(tokens);
      ok = x !== null && y !== null;
      if (ok) {
        builder.lineTo([ox + (x as number), oy + (y as number)]);
      }
    } else if (upper === 'H') {
      const x = readNumber(tokens);
      ok = x !== null;
      if (ok) {
        builder.lineTo([ox + (x as number), base[1]]);
      }
    } else if (upper === 'V') {
      const y = readNumber(tokens);
      ok = y !== null;
      if (ok) {
        builder.lineTo([base[0], oy + (y as number)]);
      }
    } else if (upper === 'C') {
      const values = readNumbers(tokens, 6);
      ok = values !== null;
      if (values !== null) {
        const c1: Point2 = [ox + values[0], oy + values[1]];
        const c2: Point2 = [ox + values[2], oy + values[3]];
        const to: Point2 = [ox + values[4], oy + values[5]];
        builder.cubicTo(c1, c2, to);
        nextCubic = c2;
      }
    } else if (upper === 'S') {
      const values = readNumbers(tokens, 4);
      ok = values !== null;
      if (values !== null) {
        // The first control point mirrors the previous curve's second.
        let c1: Point2 = base;
        if (lastCubicControl !== null) {
          c1 = [2 * base[0] - lastCubicControl[0], 2 * base[1] - lastCubicControl[1]];
        }
        const c2: Point2 = [ox + values[0], oy + values[1]];
        const to: Point2 = [ox + values[2], oy + values[3]];
        builder.cubicTo(c1, c2, to);
        nextCubic = c2;
      }
    } else if (upper === 'Q') {
      const values = readNumbers(tokens, 4);
      ok = values !== null;
      if (values !== null) {
        const q: Point2 = [ox + values[0], oy + values[1]];
        const to: Point2 = [ox + values[2], oy + values[3]];
        quadraticTo(builder, base, q, to);
        nextQuad = q;
      }
    } else if (upper === 'T') {
      const values = readNumbers(tokens, 2);
      ok = values !== null;
      if (values !== null) {
        let q: Point2 = base;
        if (lastQuadControl !== null) {
          q = [2 * base[0] - lastQuadControl[0], 2 * base[1] - lastQuadControl[1]];
        }
        const to: Point2 = [ox + values[0], oy + values[1]];
        quadraticTo(builder, base, q, to);
        nextQuad = q;
      }
    } else if (upper === 'A') {
      const rx = readNumber(tokens);
      const ry = readNumber(tokens);
      const rotation = readNumber(tokens);
      const largeArc = readFlag(tokens);
      const sweep = readFlag(tokens);
      const x = readNumber(tokens);
      const y = readNumber(tokens);
      ok = rx !== null && ry !== null && rotation !== null && largeArc !== null && sweep !== null && x !== null && y !== null;
      if (ok) {
        const to: Point2 = [ox + (x as number), oy + (y as number)];
        const cubics = arcToCubics(base, rx as number, ry as number, rotation as number, largeArc === 1, sweep === 1, to);
        for (let i = 0; i < cubics.length; i++) {
          const segment = cubics[i];
          if (segment.kind === 'cubic') {
            builder.cubicTo(segment.c1, segment.c2, segment.to);
          } else {
            builder.lineTo(segment.to);
          }
        }
      }
    }
    if (!ok) {
      break;
    }
    lastCubicControl = nextCubic;
    lastQuadControl = nextQuad;
  }
  builder.finish();
  return builder.subpaths;
}

function readNumbers(tokens: Tokens, count: number): number[] | null {
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const value = readNumber(tokens);
    if (value === null) {
      return null;
    }
    values.push(value);
  }
  return values;
}

// A quadratic Bezier is exactly the cubic with control points 2/3 of the way
// from each end to the quadratic's control point.
function quadraticTo(builder: PathBuilder, from: Point2, q: Point2, to: Point2): void {
  const c1: Point2 = [from[0] + ((q[0] - from[0]) * 2) / 3, from[1] + ((q[1] - from[1]) * 2) / 3];
  const c2: Point2 = [to[0] + ((q[0] - to[0]) * 2) / 3, to[1] + ((q[1] - to[1]) * 2) / 3];
  builder.cubicTo(c1, c2, to);
}

// An SVG elliptical arc (endpoint form) as cubics, at most 90 degrees each.
// Follows the SVG specification, appendix B.2.4 (endpoint to centre
// conversion, with out-of-range radii scaled up).
export function arcToCubics(
  from: Point2,
  rxIn: number,
  ryIn: number,
  rotationDegrees: number,
  largeArc: boolean,
  sweep: boolean,
  to: Point2,
): Segment[] {
  if (Math.abs(from[0] - to[0]) < 1e-12 && Math.abs(from[1] - to[1]) < 1e-12) {
    return []; // same end points: the arc is omitted
  }
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) {
    return [{ kind: 'line', to: to }];
  }
  const phi = (rotationDegrees * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  // Step 1: the midpoint, in the ellipse's own axes.
  const hx = (from[0] - to[0]) / 2;
  const hy = (from[1] - to[1]) / 2;
  const x1 = cosPhi * hx + sinPhi * hy;
  const y1 = -sinPhi * hx + cosPhi * hy;
  // Radii too small to reach: scale them up just enough.
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    const grow = Math.sqrt(lambda);
    rx = rx * grow;
    ry = ry * grow;
  }
  // Step 2: the centre, in the ellipse's axes.
  const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let factor = Math.sqrt(Math.max(0, numerator / denominator));
  if (largeArc === sweep) {
    factor = -factor;
  }
  const cxPrime = (factor * rx * y1) / ry;
  const cyPrime = (-factor * ry * x1) / rx;
  // Step 3: the centre in user space.
  const cx = cosPhi * cxPrime - sinPhi * cyPrime + (from[0] + to[0]) / 2;
  const cy = sinPhi * cxPrime + cosPhi * cyPrime + (from[1] + to[1]) / 2;
  // Step 4: start angle and sweep.
  const startAngle = Math.atan2((y1 - cyPrime) / ry, (x1 - cxPrime) / rx);
  const endAngle = Math.atan2((-y1 - cyPrime) / ry, (-x1 - cxPrime) / rx);
  let delta = endAngle - startAngle;
  if (sweep && delta < 0) {
    delta = delta + 2 * Math.PI;
  } else if (!sweep && delta > 0) {
    delta = delta - 2 * Math.PI;
  }
  const pieces = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / pieces;
  // Each piece: the standard cubic for a circular arc of angle `step`,
  // stretched to the ellipse and rotated.
  const k = (4 / 3) * Math.tan(step / 4);
  const result: Segment[] = [];
  function ellipsePoint(angle: number): Point2 {
    const ex = rx * Math.cos(angle);
    const ey = ry * Math.sin(angle);
    return [cx + cosPhi * ex - sinPhi * ey, cy + sinPhi * ex + cosPhi * ey];
  }
  function ellipseTangent(angle: number): Point2 {
    const ex = -rx * Math.sin(angle);
    const ey = ry * Math.cos(angle);
    return [cosPhi * ex - sinPhi * ey, sinPhi * ex + cosPhi * ey];
  }
  for (let i = 0; i < pieces; i++) {
    const a0 = startAngle + i * step;
    const a1 = a0 + step;
    const p0 = ellipsePoint(a0);
    const p3 = ellipsePoint(a1);
    const t0 = ellipseTangent(a0);
    const t1 = ellipseTangent(a1);
    const c1: Point2 = [p0[0] + k * t0[0], p0[1] + k * t0[1]];
    const c2: Point2 = [p3[0] - k * t1[0], p3[1] - k * t1[1]];
    let end = p3;
    if (i === pieces - 1) {
      end = [to[0], to[1]]; // land exactly on the requested end point
    }
    const cubic: CubicSegment = { kind: 'cubic', c1: c1, c2: c2, to: end };
    result.push(cubic);
  }
  return result;
}

// The basic shapes, as the SVG specification defines them in path terms.

export function rectPath(x: number, y: number, width: number, height: number, rxIn: number | null, ryIn: number | null): Subpath[] {
  if (width <= 0 || height <= 0) {
    return [];
  }
  // rx and ry: a missing one takes the other's value; both clamp to half the side.
  let rx = rxIn === null ? (ryIn === null ? 0 : ryIn) : rxIn;
  let ry = ryIn === null ? rx : ryIn;
  rx = Math.min(Math.max(0, rx), width / 2);
  ry = Math.min(Math.max(0, ry), height / 2);
  if (rx === 0 || ry === 0) {
    const d = 'M' + [x, y].join(' ') + 'H' + String(x + width) + 'V' + String(y + height) + 'H' + String(x) + 'Z';
    return parsePathData(d);
  }
  const parts: string[] = [];
  parts.push('M', String(x + rx), String(y));
  parts.push('H', String(x + width - rx));
  parts.push('A', String(rx), String(ry), '0 0 1', String(x + width), String(y + ry));
  parts.push('V', String(y + height - ry));
  parts.push('A', String(rx), String(ry), '0 0 1', String(x + width - rx), String(y + height));
  parts.push('H', String(x + rx));
  parts.push('A', String(rx), String(ry), '0 0 1', String(x), String(y + height - ry));
  parts.push('V', String(y + ry));
  parts.push('A', String(rx), String(ry), '0 0 1', String(x + rx), String(y));
  parts.push('Z');
  return parsePathData(parts.join(' '));
}

export function ellipsePath(cx: number, cy: number, rx: number, ry: number): Subpath[] {
  if (rx <= 0 || ry <= 0) {
    return [];
  }
  const parts: string[] = [];
  parts.push('M', String(cx + rx), String(cy));
  parts.push('A', String(rx), String(ry), '0 0 1', String(cx), String(cy + ry));
  parts.push('A', String(rx), String(ry), '0 0 1', String(cx - rx), String(cy));
  parts.push('A', String(rx), String(ry), '0 0 1', String(cx), String(cy - ry));
  parts.push('A', String(rx), String(ry), '0 0 1', String(cx + rx), String(cy));
  parts.push('Z');
  return parsePathData(parts.join(' '));
}

// polygon and polyline: a list of points. A polyline is filled as if closed,
// so both come out closed.
export function pointsPath(points: string): Subpath[] {
  const tokens: Tokens = { text: points, index: 0 };
  const coordinates: number[] = [];
  for (;;) {
    const value = readNumber(tokens);
    if (value === null) {
      break;
    }
    coordinates.push(value);
  }
  if (coordinates.length < 6) {
    return [];
  }
  const segments: Segment[] = [];
  for (let i = 2; i + 1 < coordinates.length; i = i + 2) {
    segments.push({ kind: 'line', to: [coordinates[i], coordinates[i + 1]] });
  }
  const start: Point2 = [coordinates[0], coordinates[1]];
  const last = segments[segments.length - 1].to;
  if (Math.hypot(last[0] - start[0], last[1] - start[1]) > 1e-9) {
    segments.push({ kind: 'line', to: [start[0], start[1]] });
  }
  return [{ start: start, segments: segments }];
}
