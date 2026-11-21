// The project file (.dc6): one JSON file holding everything needed to open
// the project anywhere (brief v1 4.7):
//   - the document (parts placed, decals, vinyl colours, part colours);
//   - the artwork library, as the SVG text each artwork was read from;
//   - every STEP file in use, by name and SHA-256 hash, with the file
//     itself embedded (gzip, then base64; plain base64 where the browser
//     has no CompressionStream);
//   - which loaded part is which solid of which file, so the parts get
//     back the ids the document refers to.
// `version` is the format's version. Reading checks it and every hash.
//
// Kept apart from the browser: this runs in Node for the tests.

import type { AssemblyDocument } from './document.ts';

export const projectFormat = 'dc6-project';
export const projectVersion = 1;

export interface ProjectStepFile {
  name: string;
  bytes: Uint8Array;
  // 'sha256:' and the hex digest of the bytes.
  hash: string;
}

export interface ProjectPart {
  // The part's id (what the document refers to).
  id: string;
  // Index into `files`, and which solid of that file (0 first).
  file: number;
  solid: number;
}

export interface ProjectArtwork {
  id: string;
  name: string;
  fileName: string;
  svg: string;
}

export interface ProjectContent {
  document: AssemblyDocument;
  // Loaded parts in the order of the parts list; `parts` may hold more
  // (a part the document still uses but the list no longer shows).
  partOrder: string[];
  parts: ProjectPart[];
  files: ProjectStepFile[];
  artworks: ProjectArtwork[];
  artworkOrder: string[];
}

// The file as written.
interface StoredFile {
  name: string;
  hash: string;
  size: number;
  encoding: 'gzip-base64' | 'base64';
  data: string;
}

interface StoredProject {
  format: string;
  version: number;
  document: AssemblyDocument;
  partOrder: string[];
  parts: ProjectPart[];
  files: StoredFile[];
  artworks: ProjectArtwork[];
  artworkOrder: string[];
}

export async function writeProject(content: ProjectContent): Promise<string> {
  const files: StoredFile[] = [];
  for (let i = 0; i < content.files.length; i++) {
    const file = content.files[i];
    const packed = await gzip(file.bytes);
    let encoding: StoredFile['encoding'] = 'base64';
    let data = '';
    if (packed !== null) {
      encoding = 'gzip-base64';
      data = toBase64(packed);
    } else {
      data = toBase64(file.bytes);
    }
    files.push({ name: file.name, hash: file.hash, size: file.bytes.length, encoding: encoding, data: data });
  }
  const stored: StoredProject = {
    format: projectFormat,
    version: projectVersion,
    document: content.document,
    partOrder: content.partOrder,
    parts: content.parts,
    files: files,
    artworks: content.artworks,
    artworkOrder: content.artworkOrder,
  };
  return JSON.stringify(stored);
}

export async function readProject(text: string): Promise<ProjectContent> {
  let stored: StoredProject;
  try {
    stored = JSON.parse(text) as StoredProject;
  } catch {
    throw new Error('not a DC6 project file (it is not JSON)');
  }
  if (stored === null || typeof stored !== 'object' || stored.format !== projectFormat) {
    throw new Error('not a DC6 project file');
  }
  if (stored.version > projectVersion) {
    throw new Error('made by a newer DC6 (project version ' + String(stored.version) + '; this one reads up to ' + String(projectVersion) + ')');
  }
  const files: ProjectStepFile[] = [];
  for (let i = 0; i < stored.files.length; i++) {
    const file = stored.files[i];
    let bytes = fromBase64(file.data);
    if (file.encoding === 'gzip-base64') {
      const unpacked = await gunzip(bytes);
      if (unpacked === null) {
        throw new Error(file.name + ' is compressed and this browser cannot uncompress it');
      }
      bytes = unpacked;
    }
    const hash = await hashBytes(bytes);
    if (hash !== file.hash || bytes.length !== file.size) {
      throw new Error(file.name + ' in the project is damaged (its hash does not match)');
    }
    files.push({ name: file.name, bytes: bytes, hash: hash });
  }
  return {
    document: stored.document,
    partOrder: stored.partOrder,
    parts: stored.parts,
    files: files,
    artworks: stored.artworks,
    artworkOrder: stored.artworkOrder,
  };
}

// ---------------------------------------------------------------------------
// Bytes: hash, gzip, base64.

// 'sha256:' and the hex digest, with the platform's SubtleCrypto (the
// browser's in a secure context, and Node's). Where there is none (a page
// served over plain http from another machine), an FNV-1a digest instead,
// marked as such: it still tells a changed file from the same one.
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto !== undefined ? globalThis.crypto.subtle : undefined;
  if (subtle !== undefined) {
    const digest = await subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
    return 'sha256:' + toHex(new Uint8Array(digest));
  }
  return 'fnv1a32:' + fnv1a(bytes);
}

function toHex(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i++) {
    text = text + bytes[i].toString(16).padStart(2, '0');
  }
  return text;
}

function fnv1a(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash = hash ^ bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') {
    return null;
  }
  return streamThrough(bytes, new CompressionStream('gzip'));
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') {
    return null;
  }
  return streamThrough(bytes, new DecompressionStream('gzip'));
}

async function streamThrough(bytes: Uint8Array, transform: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const blob = new Blob([bytes as unknown as ArrayBuffer]);
  const stream = blob.stream().pipeThrough(transform);
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i = i + 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    chunk = chunk + base64Alphabet[(triple >> 18) & 63] + base64Alphabet[(triple >> 12) & 63];
    chunk = chunk + (i + 1 < bytes.length ? base64Alphabet[(triple >> 6) & 63] : '=');
    chunk = chunk + (i + 2 < bytes.length ? base64Alphabet[triple & 63] : '=');
    // Join in pieces: one long string built a character at a time is slow.
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = '';
    }
  }
  parts.push(chunk);
  return parts.join('');
}

export function fromBase64(text: string): Uint8Array {
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < base64Alphabet.length; i++) {
    lookup[base64Alphabet.charCodeAt(i)] = i;
  }
  let padding = 0;
  if (text.endsWith('==')) {
    padding = 2;
  } else if (text.endsWith('=')) {
    padding = 1;
  }
  const length = (text.length / 4) * 3 - padding;
  if (text.length % 4 !== 0) {
    throw new Error('fromBase64: the text is not base64 (its length is not a multiple of 4)');
  }
  const bytes = new Uint8Array(length);
  let out = 0;
  for (let i = 0; i < text.length; i = i + 4) {
    const a = lookup[text.charCodeAt(i)];
    const b = lookup[text.charCodeAt(i + 1)];
    const c = text[i + 2] === '=' ? 0 : lookup[text.charCodeAt(i + 2)];
    const d = text[i + 3] === '=' ? 0 : lookup[text.charCodeAt(i + 3)];
    if (a < 0 || b < 0 || c < 0 || d < 0) {
      throw new Error('fromBase64: the text is not base64');
    }
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    if (out < length) {
      bytes[out] = (triple >> 16) & 255;
      out = out + 1;
    }
    if (out < length) {
      bytes[out] = (triple >> 8) & 255;
      out = out + 1;
    }
    if (out < length) {
      bytes[out] = triple & 255;
      out = out + 1;
    }
  }
  return bytes;
}
