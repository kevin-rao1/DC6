// Web Worker that builds the flat page (most of a second of ray casts on a
// typical rocket), so the window stays live while it runs.

import { buildPage } from '../geometry/page.ts';
import { makePiece } from '../geometry/geodesic.ts';
import type { SurfacePiece } from '../geometry/geodesic.ts';
import type { PieceInfo } from '../geometry/page-islands.ts';
import type { PageRequest, PageResponse, PageWorkerPart } from './page-protocol.ts';

const parts = new Map<number, PageWorkerPart>();

self.onmessage = function onMessage(event: MessageEvent<PageRequest>) {
  const request = event.data;
  try {
    for (let i = 0; i < request.parts.length; i++) {
      parts.set(request.parts[i].key, request.parts[i]);
    }
    const pieces: SurfacePiece[] = [];
    const info: PieceInfo[] = [];
    for (let i = 0; i < request.pieces.length; i++) {
      const wanted = request.pieces[i];
      const part = parts.get(wanted.key);
      if (part === undefined) {
        throw new Error('page worker: part ' + String(wanted.key) + ' was never sent');
      }
      pieces.push(makePiece(wanted.placedId, part.mesh, part.bvh, part.positions, part.indices, wanted.transform));
      info.push({ name: part.name, faces: part.faces, triangleFace: part.triangleFace, symmetryNumber: wanted.symmetryNumber, onBody: wanted.onBody });
    }
    const page = buildPage({ pieces: pieces }, info);
    // The window has the surface; do not copy it back.
    page.surface = { pieces: [] };
    const message: PageResponse = { kind: 'page', id: request.id, page: page };
    self.postMessage(message);
  } catch (error) {
    let text = String(error);
    if (error instanceof Error) {
      text = error.message;
    }
    const message: PageResponse = { kind: 'error', id: request.id, message: text };
    self.postMessage(message);
  }
};
