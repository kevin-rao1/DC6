// The pieces of vinyl a document needs cut: every decal shown on a visible
// part, with linked copies that come out the same cut once with a quantity.
//
// Two members of a symmetry set are the same piece when their artwork,
// size, flips and colours are the same. Copies round the rocket always are;
// a mirror image is too unless its artwork is flipped, in which case the
// flipped ones are a piece of their own, named "(mirrored)".

import type { Artwork } from '../geometry/artwork.ts';
import type { CutPiece } from '../geometry/cut-export.ts';
import type { AssemblyDocument } from './document.ts';
import { findPlaced } from './document.ts';
import type { Decal } from './decals.ts';

// The decals each piece stands for, in the same order as cutPiecesOf.
export interface PieceSource {
  piece: CutPiece;
  decals: Decal[];
}

export function cutPieceSources(doc: AssemblyDocument, artworks: Map<string, Artwork>): PieceSource[] {
  const result: PieceSource[] = [];
  const byKey = new Map<string, PieceSource>();
  for (let i = 0; i < doc.decals.length; i++) {
    const decal = doc.decals[i];
    if (decal.hidden) {
      continue;
    }
    const placed = findPlaced(doc, decal.anchor.placedId);
    if (placed === null || placed.hidden) {
      continue;
    }
    const artwork = artworks.get(decal.artworkId);
    if (artwork === undefined) {
      continue;
    }
    let key = 'decal:' + decal.id;
    let flippedImage = false;
    if (decal.symmetry !== null) {
      key = JSON.stringify(['group', decal.symmetry.group, decal.artworkId, decal.width, decal.height, decal.flipX, decal.flipY, decal.colourMap]);
      flippedImage = decal.symmetry.mirrored && decal.symmetry.flipMirror;
    }
    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.piece.quantity = existing.piece.quantity + 1;
      existing.decals.push(decal);
      continue;
    }
    let name = decal.name;
    if (flippedImage) {
      name = name + ' (mirrored)';
    }
    const source: PieceSource = {
      piece: {
        name: name,
        artwork: artwork,
        width: decal.width,
        height: decal.height,
        flipX: decal.flipX,
        flipY: decal.flipY,
        colourMap: decal.colourMap,
        quantity: 1,
      },
      decals: [decal],
    };
    byKey.set(key, source);
    result.push(source);
  }
  return result;
}

export function cutPiecesOf(doc: AssemblyDocument, artworks: Map<string, Artwork>): CutPiece[] {
  const sources = cutPieceSources(doc, artworks);
  const pieces: CutPiece[] = [];
  for (let i = 0; i < sources.length; i++) {
    pieces.push(sources[i].piece);
  }
  return pieces;
}
