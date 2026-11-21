// The project as files: which STEP file each loaded part came from (with
// the bytes, for the project file and autosave), what goes into a project,
// and opening one again.

import type { Part } from '../geometry/part.ts';
import type { ProjectArtwork, ProjectContent, ProjectPart, ProjectStepFile } from '../model/project.ts';
import { hashBytes } from '../model/project.ts';
import type { Editor } from './editor.ts';
import type { Importer } from './importer.ts';

interface PartSource {
  file: ProjectStepFile;
  solid: number;
}

export class ProjectFiles {
  private readonly editor: Editor;
  private readonly importer: Importer;
  // Loaded part id -> its file and solid number.
  private readonly sources = new Map<string, PartSource>();
  // Files whose hash is still being worked out.
  private pending: Promise<void>[] = [];
  // True while a project is being opened (autosave waits).
  loading = false;

  constructor(editor: Editor, importer: Importer) {
    this.editor = editor;
    this.importer = importer;
  }

  // Read a STEP file into parts, remembering where they came from (unless
  // `remember` is false: a revised file, whose part gets a fresh id first
  // and is remembered with `remember`). The bytes are copied first: the
  // import worker takes the buffer it is sent.
  async importStep(name: string, bytes: Uint8Array, remember = true): Promise<{ parts: Part[]; file: ProjectStepFile }> {
    const kept = bytes.slice(0);
    const file: ProjectStepFile = { name: name, bytes: kept, hash: '' };
    const hashing = hashBytes(kept).then(function hashed(hash) {
      file.hash = hash;
    });
    this.pending.push(hashing);
    const sent = bytes.slice(0);
    const parts = await this.importer.importFile(name, sent.buffer as ArrayBuffer);
    if (remember) {
      for (let i = 0; i < parts.length; i++) {
        this.sources.set(parts[i].id, { file: file, solid: i });
      }
    }
    return { parts: parts, file: file };
  }

  remember(partId: string, file: ProjectStepFile, solid: number): void {
    this.sources.set(partId, { file: file, solid: solid });
  }

  clear(): void {
    this.sources.clear();
    this.pending = [];
  }

  // Everything the project file holds, as it is now.
  async content(): Promise<ProjectContent> {
    await Promise.all(this.pending);
    const editor = this.editor;
    const doc = editor.document;
    // The parts listed, and any the document uses that are not.
    const wanted: string[] = [];
    for (let i = 0; i < editor.partOrder.length; i++) {
      wanted.push(editor.partOrder[i]);
    }
    for (let i = 0; i < doc.placed.length; i++) {
      if (wanted.indexOf(doc.placed[i].partId) < 0) {
        wanted.push(doc.placed[i].partId);
      }
    }
    const files: ProjectStepFile[] = [];
    const parts: ProjectPart[] = [];
    for (let i = 0; i < wanted.length; i++) {
      const source = this.sources.get(wanted[i]);
      if (source === undefined) {
        continue;
      }
      let index = files.indexOf(source.file);
      if (index < 0) {
        files.push(source.file);
        index = files.length - 1;
      }
      parts.push({ id: wanted[i], file: index, solid: source.solid });
    }
    // The artwork the list shows and any a decal uses.
    const decals = editor.decals;
    const artworkIds: string[] = [];
    for (let i = 0; i < decals.artworkOrder.length; i++) {
      artworkIds.push(decals.artworkOrder[i]);
    }
    for (let i = 0; i < doc.decals.length; i++) {
      if (artworkIds.indexOf(doc.decals[i].artworkId) < 0) {
        artworkIds.push(doc.decals[i].artworkId);
      }
    }
    const artworks: ProjectArtwork[] = [];
    for (let i = 0; i < artworkIds.length; i++) {
      const source = decals.artworkSources.get(artworkIds[i]);
      const artwork = decals.artworks.get(artworkIds[i]);
      if (source === undefined || artwork === undefined) {
        continue;
      }
      artworks.push({ id: artworkIds[i], name: artwork.name, fileName: source.fileName, svg: source.text });
    }
    return {
      document: doc,
      partOrder: editor.partOrder.slice(),
      parts: parts,
      files: files,
      artworks: artworks,
      artworkOrder: decals.artworkOrder.slice(),
    };
  }

  // Open a project: everything there was is replaced. The STEP files are
  // read again (in the worker), the artwork from its SVG text, and the
  // document is shown with nothing to undo. `progress` is told of each
  // file as it starts and ends.
  async open(content: ProjectContent, progress: (name: string, done: boolean) => void): Promise<string[]> {
    this.loading = true;
    const notices: string[] = [];
    try {
      this.editor.clearAll();
      this.clear();
      const loaded = new Map<string, Part>();
      for (let f = 0; f < content.files.length; f++) {
        const file = content.files[f];
        progress(file.name, false);
        try {
          const parts = await this.importer.importFile(file.name, file.bytes.slice(0).buffer as ArrayBuffer);
          for (let p = 0; p < content.parts.length; p++) {
            const entry = content.parts[p];
            if (entry.file !== f || entry.solid >= parts.length) {
              continue;
            }
            // A part object per id: the same solid can be listed twice
            // only by a damaged file, and then the first wins.
            if (loaded.has(entry.id)) {
              continue;
            }
            const part = parts[entry.solid];
            part.id = entry.id;
            loaded.set(entry.id, part);
            this.sources.set(entry.id, { file: file, solid: entry.solid });
          }
        } finally {
          progress(file.name, true);
        }
      }
      for (let i = 0; i < content.partOrder.length; i++) {
        const part = loaded.get(content.partOrder[i]);
        if (part !== undefined) {
          this.editor.addPart(part, true);
        }
      }
      const editor = this.editor;
      loaded.forEach(function unlisted(part, id) {
        if (content.partOrder.indexOf(id) < 0) {
          editor.addPart(part, false);
        }
      });
      for (let i = 0; i < content.artworks.length; i++) {
        const artwork = content.artworks[i];
        const listed = content.artworkOrder.indexOf(artwork.id) >= 0;
        const result = this.editor.decals.restoreArtwork(artwork.id, artwork.svg, artwork.fileName, listed);
        for (let k = 0; k < result.notices.length; k++) {
          if (notices.indexOf(result.notices[k]) < 0) {
            notices.push(result.notices[k]);
          }
        }
      }
      // Missing parts would leave the document pointing at nothing.
      for (let i = 0; i < content.document.placed.length; i++) {
        if (!this.editor.parts.has(content.document.placed[i].partId)) {
          throw new Error('the project uses a part (' + content.document.placed[i].partId + ') it does not contain');
        }
      }
      this.editor.loadDocument(content.document);
    } finally {
      this.loading = false;
    }
    return notices;
  }
}
