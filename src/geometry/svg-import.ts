// SVG file -> decal artwork: the filled shapes, grouped by colour, at their
// real size in millimetres.
//
// What is read: path (all commands, arcs included), rect (rounded too),
// circle, ellipse, polygon, polyline (closed, as it is filled), groups,
// nested svg, use, transforms at every level, fill / fill-rule /
// fill-opacity / opacity / display / visibility / color, from presentation
// attributes, style attributes and simple <style> rules (.class, #id, tag:
// what Illustrator and Inkscape write).
//
// What is left out, with a notice: live text (it must be converted to paths:
// DC6 does not guess fonts), raster images, gradient and pattern fills (one
// vinyl colour cannot show them). Stroked outlines are not vinyl and are
// skipped; only a file with nothing but strokes gets a notice.
//
// Size: width and height with physical units (mm, cm, in, pt, pc, Q) give
// the size. Without units, or with px, one user unit is taken to be one CSS
// pixel, 1/96 inch, the convention of browsers and Inkscape. (Some old
// Illustrator files mean 1/72 inch; those arrive 75% of their size and the
// user scales them.)

import type { Artwork, FillRule, Matrix2, Shape, Subpath } from './artwork.ts';
import { identityMatrix, multiplyMatrix, shapesBox, transformSubpath } from './artwork.ts';
import { ellipsePath, parsePathData, pointsPath, rectPath } from './svg-path.ts';
import { parseColour } from './svg-colours.ts';
import type { XmlElement } from './xml.ts';
import { parseXml } from './xml.ts';

export interface SvgImport {
  // Null when nothing in the file can be cut.
  artwork: Artwork | null;
  // Problems to tell the user about, one sentence each.
  notices: string[];
}

export const millimetresPerPixel = 25.4 / 96;

const unitMillimetres: Record<string, number> = {
  '': millimetresPerPixel,
  px: millimetresPerPixel,
  mm: 1,
  cm: 10,
  q: 0.25,
  in: 25.4,
  pt: 25.4 / 72,
  pc: 25.4 / 6,
};

interface Length {
  value: number;
  unit: string; // lower case; '%' for percentages
}

function parseLength(text: string | undefined): Length | null {
  if (text === undefined) {
    return null;
  }
  const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Z%]*)\s*$/.exec(text);
  if (match === null) {
    return null;
  }
  return { value: Number(match[1]), unit: match[2].toLowerCase() };
}

// A length as a plain number of user units (attributes such as x, r).
// Percentages are taken of `reference` (the viewport size that applies).
function userLength(text: string | undefined, fallback: number, reference: number): number {
  const length = parseLength(text);
  if (length === null) {
    return fallback;
  }
  if (length.unit === '%') {
    return (length.value / 100) * reference;
  }
  const millimetres = unitMillimetres[length.unit];
  if (millimetres === undefined || length.unit === '' || length.unit === 'px') {
    return length.value;
  }
  // A physical unit inside the drawing: convert to user units (px).
  return (length.value * millimetres) / millimetresPerPixel;
}

function parseNumberList(text: string): number[] {
  const values: number[] = [];
  const matches = text.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g);
  if (matches === null) {
    return values;
  }
  for (let i = 0; i < matches.length; i++) {
    values.push(Number(matches[i]));
  }
  return values;
}

export function parseTransform(text: string | undefined): Matrix2 {
  let result = identityMatrix();
  if (text === undefined) {
    return result;
  }
  const pattern = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match = pattern.exec(text);
  while (match !== null) {
    const name = match[1];
    const values = parseNumberList(match[2]);
    let m: Matrix2 = identityMatrix();
    if (name === 'matrix' && values.length === 6) {
      m = [values[0], values[1], values[2], values[3], values[4], values[5]];
    } else if (name === 'translate' && values.length >= 1) {
      const ty = values.length > 1 ? values[1] : 0;
      m = [1, 0, 0, 1, values[0], ty];
    } else if (name === 'scale' && values.length >= 1) {
      const sy = values.length > 1 ? values[1] : values[0];
      m = [values[0], 0, 0, sy, 0, 0];
    } else if (name === 'rotate' && values.length >= 1) {
      const angle = (values[0] * Math.PI) / 180;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      m = [c, s, -s, c, 0, 0];
      if (values.length >= 3) {
        // rotate(a, cx, cy) = translate(cx, cy) rotate(a) translate(-cx, -cy)
        const there: Matrix2 = [1, 0, 0, 1, values[1], values[2]];
        const back: Matrix2 = [1, 0, 0, 1, -values[1], -values[2]];
        m = multiplyMatrix(there, multiplyMatrix(m, back));
      }
    } else if (name === 'skewX' && values.length >= 1) {
      m = [1, 0, Math.tan((values[0] * Math.PI) / 180), 1, 0, 0];
    } else if (name === 'skewY' && values.length >= 1) {
      m = [1, Math.tan((values[0] * Math.PI) / 180), 0, 1, 0, 0];
    }
    // Listed transforms apply right to left to the content: the first is outermost.
    result = multiplyMatrix(result, m);
    match = pattern.exec(text);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Styles.

interface SimpleSelector {
  tag: string | null;
  id: string | null;
  classes: string[];
}

interface CssRule {
  selector: SimpleSelector;
  specificity: number;
  order: number;
  declarations: Record<string, string>;
}

function parseDeclarations(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const parts = text.split(';');
  for (let i = 0; i < parts.length; i++) {
    const colon = parts[i].indexOf(':');
    if (colon < 0) {
      continue;
    }
    const name = parts[i].slice(0, colon).trim().toLowerCase();
    let value = parts[i].slice(colon + 1).trim();
    value = value.replace(/\s*!important\s*$/i, '');
    if (name !== '') {
      result[name] = value;
    }
  }
  return result;
}

// One compound selector: tag, .class (any number), #id. Anything more
// complex (descendants, attributes, pseudo-classes) is not understood and
// returns null, so the rule is skipped rather than applied too widely.
function parseSelector(text: string): SimpleSelector | null {
  const trimmed = text.trim();
  if (trimmed === '' || !/^[\w-]*([.#][\w-]+)*$/.test(trimmed)) {
    return null;
  }
  const selector: SimpleSelector = { tag: null, id: null, classes: [] };
  const tagMatch = /^[\w-]+/.exec(trimmed);
  if (tagMatch !== null) {
    selector.tag = tagMatch[0];
  }
  const pieces = trimmed.match(/[.#][\w-]+/g);
  if (pieces !== null) {
    for (let i = 0; i < pieces.length; i++) {
      if (pieces[i][0] === '#') {
        selector.id = pieces[i].slice(1);
      } else {
        selector.classes.push(pieces[i].slice(1));
      }
    }
  }
  return selector;
}

function parseCss(text: string, rules: CssRule[]): void {
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const pattern = /([^{}]+)\{([^}]*)\}/g;
  let match = pattern.exec(withoutComments);
  while (match !== null) {
    const declarations = parseDeclarations(match[2]);
    const selectors = match[1].split(',');
    for (let i = 0; i < selectors.length; i++) {
      const selector = parseSelector(selectors[i]);
      if (selector === null) {
        continue;
      }
      let specificity = 0;
      if (selector.tag !== null) {
        specificity = specificity + 1;
      }
      specificity = specificity + 10 * selector.classes.length;
      if (selector.id !== null) {
        specificity = specificity + 100;
      }
      rules.push({ selector: selector, specificity: specificity, order: rules.length, declarations: declarations });
    }
    match = pattern.exec(withoutComments);
  }
}

function matches(selector: SimpleSelector, tag: string, element: XmlElement): boolean {
  if (selector.tag !== null && selector.tag !== tag) {
    return false;
  }
  if (selector.id !== null && element.attributes.id !== selector.id) {
    return false;
  }
  if (selector.classes.length > 0) {
    const classText = element.attributes.class ?? '';
    const own = classText.split(/\s+/);
    for (let i = 0; i < selector.classes.length; i++) {
      if (own.indexOf(selector.classes[i]) < 0) {
        return false;
      }
    }
  }
  return true;
}

const styleProperties = ['fill', 'fill-rule', 'fill-opacity', 'opacity', 'stroke', 'display', 'visibility', 'color'];

// The properties declared on an element: presentation attributes, then
// style sheet rules by specificity, then the style attribute.
function declaredStyle(element: XmlElement, tag: string, rules: CssRule[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < styleProperties.length; i++) {
    const value = element.attributes[styleProperties[i]];
    if (value !== undefined) {
      result[styleProperties[i]] = value.trim();
    }
  }
  const matching: CssRule[] = [];
  for (let i = 0; i < rules.length; i++) {
    if (matches(rules[i].selector, tag, element)) {
      matching.push(rules[i]);
    }
  }
  matching.sort(function bySpecificity(a, b) {
    if (a.specificity !== b.specificity) {
      return a.specificity - b.specificity;
    }
    return a.order - b.order;
  });
  for (let i = 0; i < matching.length; i++) {
    Object.assign(result, matching[i].declarations);
  }
  const inline = element.attributes.style;
  if (inline !== undefined) {
    Object.assign(result, parseDeclarations(inline));
  }
  return result;
}

interface Computed {
  fill: string;
  fillRule: FillRule;
  fillOpacity: number;
  stroke: string;
  visible: boolean;
  color: string;
  // Product of the opacities of this element and its ancestors.
  opacity: number;
  // display: none on this element or an ancestor.
  displayed: boolean;
}

function initialStyle(): Computed {
  return { fill: 'black', fillRule: 'nonzero', fillOpacity: 1, stroke: 'none', visible: true, color: 'black', opacity: 1, displayed: true };
}

function computeStyle(parent: Computed, declared: Record<string, string>): Computed {
  const style: Computed = Object.assign({}, parent);
  const fill = declared.fill;
  if (fill !== undefined && fill !== 'inherit') {
    style.fill = fill;
  }
  const rule = declared['fill-rule'];
  if (rule === 'evenodd' || rule === 'nonzero') {
    style.fillRule = rule;
  }
  const fillOpacity = declared['fill-opacity'];
  if (fillOpacity !== undefined && fillOpacity !== 'inherit') {
    style.fillOpacity = Number(fillOpacity);
  }
  const stroke = declared.stroke;
  if (stroke !== undefined && stroke !== 'inherit') {
    style.stroke = stroke;
  }
  const visibility = declared.visibility;
  if (visibility !== undefined && visibility !== 'inherit') {
    style.visible = visibility !== 'hidden' && visibility !== 'collapse';
  }
  const color = declared.color;
  if (color !== undefined && color !== 'inherit') {
    style.color = color;
  }
  const opacity = declared.opacity;
  if (opacity !== undefined && opacity !== 'inherit') {
    style.opacity = parent.opacity * Number(opacity);
  }
  if (declared.display === 'none') {
    style.displayed = false;
  }
  return style;
}

// ---------------------------------------------------------------------------
// Walking the drawing.

interface Viewport {
  width: number;
  height: number;
}

interface Walk {
  rules: CssRule[];
  byId: Map<string, XmlElement>;
  shapes: Shape[];
  liveText: number;
  images: number;
  gradients: number;
  strokeOnly: number;
  depth: number;
}

// Elements whose content is not drawn where it stands.
const notDrawn = new Set<string>([
  'defs',
  'clipPath',
  'mask',
  'marker',
  'pattern',
  'linearGradient',
  'radialGradient',
  'symbol',
  'metadata',
  'title',
  'desc',
  'style',
  'script',
  'filter',
  'foreignObject',
]);

const textElements = new Set<string>(['text', 'tspan', 'textPath', 'flowRoot', 'flowPara']);

function localName(name: string): string {
  if (name.startsWith('svg:')) {
    return name.slice(4);
  }
  return name;
}

function indexIds(element: XmlElement, byId: Map<string, XmlElement>): void {
  const id = element.attributes.id;
  if (id !== undefined && !byId.has(id)) {
    byId.set(id, element);
  }
  for (let i = 0; i < element.children.length; i++) {
    indexIds(element.children[i], byId);
  }
}

function collectStyleSheets(element: XmlElement, rules: CssRule[]): void {
  if (localName(element.name) === 'style') {
    parseCss(element.text, rules);
  }
  for (let i = 0; i < element.children.length; i++) {
    collectStyleSheets(element.children[i], rules);
  }
}

// The transform that maps a viewBox onto a viewport of the given size
// (preserveAspectRatio: align and meet or slice; "none" stretches).
function viewBoxTransform(viewBox: number[], width: number, height: number, preserve: string | undefined): Matrix2 {
  const vx = viewBox[0];
  const vy = viewBox[1];
  const vw = viewBox[2];
  const vh = viewBox[3];
  let sx = width / vw;
  let sy = height / vh;
  const words = (preserve ?? 'xMidYMid meet').trim().split(/\s+/);
  const align = words[0];
  if (align === 'none') {
    return [sx, 0, 0, sy, -vx * sx, -vy * sy];
  }
  const slice = words[1] === 'slice';
  const uniform = slice ? Math.max(sx, sy) : Math.min(sx, sy);
  sx = uniform;
  sy = uniform;
  let tx = -vx * sx;
  let ty = -vy * sy;
  const spareX = width - vw * sx;
  const spareY = height - vh * sy;
  if (align.indexOf('xMid') >= 0) {
    tx = tx + spareX / 2;
  } else if (align.indexOf('xMax') >= 0) {
    tx = tx + spareX;
  }
  if (align.indexOf('YMid') >= 0) {
    ty = ty + spareY / 2;
  } else if (align.indexOf('YMax') >= 0) {
    ty = ty + spareY;
  }
  return [sx, 0, 0, sy, tx, ty];
}

function parseViewBox(text: string | undefined): number[] | null {
  if (text === undefined) {
    return null;
  }
  const values = parseNumberList(text);
  if (values.length !== 4 || values[2] <= 0 || values[3] <= 0) {
    return null;
  }
  return values;
}

// The subpaths of one shape element, in its own user units, or null if the
// element is not a filled shape.
function shapeGeometry(tag: string, element: XmlElement, viewport: Viewport): Subpath[] | null {
  const a = element.attributes;
  const diagonal = Math.hypot(viewport.width, viewport.height) / Math.SQRT2;
  if (tag === 'path') {
    return parsePathData(a.d ?? '');
  }
  if (tag === 'rect') {
    const x = userLength(a.x, 0, viewport.width);
    const y = userLength(a.y, 0, viewport.height);
    const width = userLength(a.width, 0, viewport.width);
    const height = userLength(a.height, 0, viewport.height);
    const rx = a.rx === undefined ? null : userLength(a.rx, 0, viewport.width);
    const ry = a.ry === undefined ? null : userLength(a.ry, 0, viewport.height);
    return rectPath(x, y, width, height, rx, ry);
  }
  if (tag === 'circle') {
    const r = userLength(a.r, 0, diagonal);
    return ellipsePath(userLength(a.cx, 0, viewport.width), userLength(a.cy, 0, viewport.height), r, r);
  }
  if (tag === 'ellipse') {
    const rx = userLength(a.rx, 0, viewport.width);
    const ry = userLength(a.ry, 0, viewport.height);
    return ellipsePath(userLength(a.cx, 0, viewport.width), userLength(a.cy, 0, viewport.height), rx, ry);
  }
  if (tag === 'polygon' || tag === 'polyline') {
    return pointsPath(a.points ?? '');
  }
  return null;
}

// Resolve a fill value to a colour, noting gradients and patterns.
function fillColour(style: Computed, walk: Walk): string | null {
  const fill = style.fill.trim();
  if (fill === 'none' || fill === 'transparent') {
    return null;
  }
  if (fill.startsWith('url(')) {
    const match = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)\s*(.*)$/.exec(fill);
    const target = match === null ? undefined : walk.byId.get(match[1]);
    if (target !== undefined) {
      const kind = localName(target.name);
      if (kind === 'linearGradient' || kind === 'radialGradient' || kind === 'pattern') {
        walk.gradients = walk.gradients + 1;
        return null;
      }
    }
    // A missing reference falls back to the colour after it, if any.
    if (match !== null && match[2] !== '') {
      return parseColour(match[2]);
    }
    return null;
  }
  if (fill.toLowerCase() === 'currentcolor') {
    return parseColour(style.color);
  }
  return parseColour(fill);
}

function walkElement(element: XmlElement, matrix: Matrix2, parentStyle: Computed, viewport: Viewport, walk: Walk): void {
  const tag = localName(element.name);
  if (tag.indexOf(':') >= 0 || notDrawn.has(tag)) {
    return; // another program's own elements (sodipodi:..., inkscape:...) or non-drawing ones
  }
  const style = computeStyle(parentStyle, declaredStyle(element, tag, walk.rules));
  if (!style.displayed) {
    return;
  }
  if (textElements.has(tag)) {
    walk.liveText = walk.liveText + 1;
    return;
  }
  if (tag === 'image') {
    walk.images = walk.images + 1;
    return;
  }
  const own = multiplyMatrix(matrix, parseTransform(element.attributes.transform));

  if (tag === 'svg') {
    // A nested viewport (the root is handled by importSvg).
    const x = userLength(element.attributes.x, 0, viewport.width);
    const y = userLength(element.attributes.y, 0, viewport.height);
    const width = userLength(element.attributes.width, viewport.width, viewport.width);
    const height = userLength(element.attributes.height, viewport.height, viewport.height);
    let inner: Matrix2 = [1, 0, 0, 1, x, y];
    let innerViewport: Viewport = { width: width, height: height };
    const viewBox = parseViewBox(element.attributes.viewBox);
    if (viewBox !== null) {
      inner = multiplyMatrix(inner, viewBoxTransform(viewBox, width, height, element.attributes.preserveAspectRatio));
      innerViewport = { width: viewBox[2], height: viewBox[3] };
    }
    walkChildren(element, multiplyMatrix(own, inner), style, innerViewport, walk);
    return;
  }
  if (tag === 'g' || tag === 'a' || tag === 'switch') {
    walkChildren(element, own, style, viewport, walk);
    return;
  }
  if (tag === 'use') {
    const href = element.attributes.href ?? element.attributes['xlink:href'];
    if (href === undefined || !href.startsWith('#') || walk.depth > 16) {
      return;
    }
    const target = walk.byId.get(href.slice(1));
    if (target === undefined) {
      return;
    }
    const x = userLength(element.attributes.x, 0, viewport.width);
    const y = userLength(element.attributes.y, 0, viewport.height);
    const placed = multiplyMatrix(own, [1, 0, 0, 1, x, y]);
    walk.depth = walk.depth + 1;
    if (localName(target.name) === 'symbol') {
      let inner: Matrix2 = identityMatrix();
      const viewBox = parseViewBox(target.attributes.viewBox);
      const width = userLength(element.attributes.width, viewport.width, viewport.width);
      const height = userLength(element.attributes.height, viewport.height, viewport.height);
      let innerViewport = viewport;
      if (viewBox !== null) {
        inner = viewBoxTransform(viewBox, width, height, target.attributes.preserveAspectRatio);
        innerViewport = { width: viewBox[2], height: viewBox[3] };
      }
      const symbolStyle = computeStyle(style, declaredStyle(target, 'symbol', walk.rules));
      walkChildren(target, multiplyMatrix(placed, inner), symbolStyle, innerViewport, walk);
    } else {
      walkElement(target, placed, style, viewport, walk);
    }
    walk.depth = walk.depth - 1;
    return;
  }
  const geometry = shapeGeometry(tag, element, viewport);
  if (geometry === null || geometry.length === 0) {
    return;
  }
  if (!style.visible) {
    return;
  }
  const colour = fillColour(style, walk);
  if (colour === null) {
    const stroke = style.stroke.trim();
    if (stroke !== 'none' && stroke !== '') {
      walk.strokeOnly = walk.strokeOnly + 1;
    }
    return;
  }
  if (style.fillOpacity * style.opacity <= 0) {
    return; // fully transparent: nothing to cut
  }
  const subpaths: Subpath[] = [];
  for (let i = 0; i < geometry.length; i++) {
    subpaths.push(transformSubpath(own, geometry[i]));
  }
  walk.shapes.push({ colour: colour, fillRule: style.fillRule, subpaths: subpaths });
}

function walkChildren(element: XmlElement, matrix: Matrix2, style: Computed, viewport: Viewport, walk: Walk): void {
  for (let i = 0; i < element.children.length; i++) {
    walkElement(element.children[i], matrix, style, viewport, walk);
  }
}

// The root viewport: its size in millimetres and the map from user units to
// millimetres.
function rootFrame(root: XmlElement): { matrix: Matrix2; viewport: Viewport } {
  const widthLength = parseLength(root.attributes.width);
  const heightLength = parseLength(root.attributes.height);
  const viewBox = parseViewBox(root.attributes.viewBox);
  let widthMm: number | null = null;
  let heightMm: number | null = null;
  if (widthLength !== null && widthLength.unit !== '%' && unitMillimetres[widthLength.unit] !== undefined) {
    widthMm = widthLength.value * unitMillimetres[widthLength.unit];
  }
  if (heightLength !== null && heightLength.unit !== '%' && unitMillimetres[heightLength.unit] !== undefined) {
    heightMm = heightLength.value * unitMillimetres[heightLength.unit];
  }
  if (viewBox === null) {
    // No viewBox: user units are CSS pixels, whatever size the page has.
    const scale = millimetresPerPixel;
    const viewport: Viewport = {
      width: widthMm === null ? 100 : widthMm / scale,
      height: heightMm === null ? 100 : heightMm / scale,
    };
    return { matrix: [scale, 0, 0, scale, 0, 0], viewport: viewport };
  }
  // With a viewBox but no physical size: one user unit is one CSS pixel.
  if (widthMm === null && heightMm === null) {
    widthMm = viewBox[2] * millimetresPerPixel;
    heightMm = viewBox[3] * millimetresPerPixel;
  } else if (widthMm === null && heightMm !== null) {
    widthMm = (heightMm * viewBox[2]) / viewBox[3];
  } else if (heightMm === null && widthMm !== null) {
    heightMm = (widthMm * viewBox[3]) / viewBox[2];
  }
  const matrix = viewBoxTransform(viewBox, widthMm as number, heightMm as number, root.attributes.preserveAspectRatio);
  return { matrix: matrix, viewport: { width: viewBox[2], height: viewBox[3] } };
}

export function importSvg(text: string, name: string, id: string): SvgImport {
  const root = parseXml(text);
  if (localName(root.name) !== 'svg') {
    throw new Error('Not an SVG file: the root element is <' + root.name + '>.');
  }
  const walk: Walk = {
    rules: [],
    byId: new Map<string, XmlElement>(),
    shapes: [],
    liveText: 0,
    images: 0,
    gradients: 0,
    strokeOnly: 0,
    depth: 0,
  };
  indexIds(root, walk.byId);
  collectStyleSheets(root, walk.rules);
  const frame = rootFrame(root);
  const rootStyle = computeStyle(initialStyle(), declaredStyle(root, 'svg', walk.rules));
  if (rootStyle.displayed) {
    walkChildren(root, multiplyMatrix(frame.matrix, parseTransform(root.attributes.transform)), rootStyle, frame.viewport, walk);
  }

  const notices: string[] = [];
  if (walk.liveText > 0) {
    notices.push(name + ' has live text, which was left out. Convert the text to paths in your drawing program.');
  }
  if (walk.images > 0) {
    notices.push(name + ' has a raster image, which cannot be cut and was left out.');
  }
  if (walk.gradients > 0) {
    notices.push(name + ' has gradient or pattern fills, which cannot be cut in one vinyl colour and were left out.');
  }
  if (walk.shapes.length === 0 && walk.strokeOnly > 0) {
    notices.push(name + ' has only strokes. Vinyl is cut from filled shapes: convert the strokes to paths.');
  }
  if (walk.shapes.length === 0) {
    if (notices.length === 0) {
      notices.push(name + ' has no filled shapes to cut.');
    }
    return { artwork: null, notices: notices };
  }

  // Move the artwork so its bounding box starts at the origin.
  const box = shapesBox(walk.shapes);
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  if (!(width > 0) || !(height > 0)) {
    notices.push(name + ' has no area to cut.');
    return { artwork: null, notices: notices };
  }
  const shift: Matrix2 = [1, 0, 0, 1, -box.minX, -box.minY];
  const shapes: Shape[] = [];
  const colours: string[] = [];
  for (let i = 0; i < walk.shapes.length; i++) {
    const shape = walk.shapes[i];
    const subpaths: Subpath[] = [];
    for (let k = 0; k < shape.subpaths.length; k++) {
      subpaths.push(transformSubpath(shift, shape.subpaths[k]));
    }
    shapes.push({ colour: shape.colour, fillRule: shape.fillRule, subpaths: subpaths });
    if (colours.indexOf(shape.colour) < 0) {
      colours.push(shape.colour);
    }
  }
  const artwork: Artwork = { id: id, name: name, width: width, height: height, shapes: shapes, colours: colours };
  return { artwork: artwork, notices: notices };
}
