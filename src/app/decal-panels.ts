// The decal side of the panels: the layer list (under the rocket tree), the
// colour picker that opens from a swatch, and the export dialog. Plain DOM,
// in the same style as ui.ts; everything goes through the editor.

import type { Editor } from './editor.ts';
import type { AssemblyDocument } from '../model/document.ts';
import type { Decal } from '../model/decals.ts';
import { presetVinyl, vinylFor } from '../model/decals.ts';
import { cutFiles } from '../geometry/cut-export.ts';
import type { CutOptions, CutPiece } from '../geometry/cut-export.ts';
import { findPlaced } from '../model/document.ts';

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement | null): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  if (className !== '') {
    created.className = className;
  }
  if (parent !== null) {
    parent.appendChild(created);
  }
  return created;
}

// ---------------------------------------------------------------------------
// Colour picker: a small popover of swatches.

export interface ColourChoice {
  colour: string | null; // null: the default (part grey)
  title: string;
}

export class ColourPopover {
  private readonly root: HTMLElement;
  private readonly box: HTMLDivElement;
  private onPick: ((colour: string | null) => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.box = element('div', 'popover', root);
    this.box.style.display = 'none';
    const self = this;
    window.addEventListener(
      'pointerdown',
      function outside(event) {
        if (self.box.style.display !== 'none' && !self.box.contains(event.target as Node)) {
          self.close();
        }
      },
      true,
    );
    window.addEventListener('keydown', function escape(event) {
      if (event.key === 'Escape') {
        self.close();
      }
    });
  }

  open(anchor: HTMLElement, choices: ColourChoice[], current: string | null, pick: (colour: string | null) => void): void {
    this.onPick = pick;
    this.box.textContent = '';
    const self = this;
    for (let i = 0; i < choices.length; i++) {
      const choice = choices[i];
      const swatch = element('button', 'swatch big', this.box);
      swatch.title = choice.title;
      swatch.dataset.colour = choice.colour === null ? 'default' : choice.colour;
      if (choice.colour === null) {
        swatch.classList.add('default');
      } else {
        swatch.style.background = choice.colour;
      }
      swatch.classList.toggle('current', choice.colour === current);
      swatch.addEventListener('click', function chosen() {
        self.choose(choice.colour);
      });
    }
    // Any other colour: the system colour picker.
    const more = element('label', 'swatch big more', this.box);
    more.title = 'Another colour';
    more.textContent = '+';
    const input = element('input', '', more);
    input.type = 'color';
    input.value = current === null ? '#ffffff' : current;
    input.addEventListener('change', function custom() {
      self.choose(input.value.toLowerCase());
    });
    const rect = anchor.getBoundingClientRect();
    const rootRect = this.root.getBoundingClientRect();
    this.box.style.display = '';
    const width = this.box.offsetWidth;
    let left = rect.left - rootRect.left;
    left = Math.min(left, rootRect.width - width - 8);
    this.box.style.left = String(left) + 'px';
    this.box.style.top = String(rect.bottom - rootRect.top + 4) + 'px';
  }

  private choose(colour: string | null): void {
    const pick = this.onPick;
    this.close();
    if (pick !== null) {
      pick(colour);
    }
  }

  close(): void {
    this.box.style.display = 'none';
    this.onPick = null;
  }
}

export function vinylChoices(doc: AssemblyDocument): ColourChoice[] {
  const choices: ColourChoice[] = [];
  for (let i = 0; i < presetVinyl.length; i++) {
    choices.push({ colour: presetVinyl[i].colour, title: presetVinyl[i].name + ' ' + presetVinyl[i].colour });
  }
  for (let i = 0; i < doc.vinylColours.length; i++) {
    choices.push({ colour: doc.vinylColours[i], title: doc.vinylColours[i] });
  }
  return choices;
}

// ---------------------------------------------------------------------------
// The layer list.

const layerIcons: Record<string, string> = {
  eye: '<path d="M1.5 10S5 4 10 4s8.5 6 8.5 6-3.5 6-8.5 6-8.5-6-8.5-6z"/><circle cx="10" cy="10" r="2.5"/>',
  eyeOff: '<path d="M1.5 10S5 4 10 4s8.5 6 8.5 6-3.5 6-8.5 6-8.5-6-8.5-6z" opacity="0.35"/><path d="M3 17L17 3"/>',
  lock: '<rect x="5" y="9" width="10" height="8" rx="1.5"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/>',
  unlock: '<rect x="5" y="9" width="10" height="8" rx="1.5"/><path d="M7 9V6.5a3 3 0 0 1 5.8-1"/>',
  trash: '<path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11"/>',
  replace: '<path d="M4 8a6 6 0 0 1 11-2M16 12a6 6 0 0 1-11 2"/><path d="M15 2.5V6h-3.5M5 17.5V14h3.5"/>',
};

function layerIcon(name: string): string {
  return '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + layerIcons[name] + '</svg>';
}

export class LayerList {
  readonly panel: HTMLDivElement;
  private readonly editor: Editor;
  private readonly popover: ColourPopover;
  private readonly replaceFile: (decalId: string) => void;
  private renaming: string | null = null;
  // Reordering by dragging a row.
  private dragging: { id: string; startY: number; moved: boolean; target: number } | null = null;
  private readonly marker: HTMLDivElement;

  constructor(parent: HTMLElement, editor: Editor, popover: ColourPopover, replaceFile: (decalId: string) => void) {
    this.editor = editor;
    this.popover = popover;
    this.replaceFile = replaceFile;
    this.panel = element('div', 'tree layers', parent);
    this.marker = element('div', 'drop-marker', null);
    const self = this;
    window.addEventListener('pointermove', function move(event) {
      self.dragMove(event);
    });
    window.addEventListener('pointerup', function up() {
      self.dragEnd();
    });
  }

  refresh(): void {
    if (this.dragging !== null && this.dragging.moved) {
      return; // do not rebuild under the pointer
    }
    const editor = this.editor;
    const doc = editor.document;
    this.panel.textContent = '';
    this.panel.style.display = doc.decals.length > 0 ? '' : 'none';
    // Top layer first, as in drawing programs.
    for (let layer = doc.decals.length - 1; layer >= 0; layer--) {
      this.row(doc, doc.decals[layer]);
    }
  }

  private row(doc: AssemblyDocument, decal: Decal): void {
    const editor = this.editor;
    const self = this;
    const row = element('div', 'tree-row layer-row', this.panel);
    row.dataset.decalId = decal.id;
    row.classList.toggle('selected', editor.decals.selectedId === decal.id);
    row.classList.toggle('hidden-part', decal.hidden);
    row.classList.toggle('locked', decal.locked);
    const artwork = editor.decals.artworks.get(decal.artworkId);
    const swatches = element('span', 'swatches', row);
    if (artwork !== undefined) {
      for (let i = 0; i < artwork.colours.length; i++) {
        const original = artwork.colours[i];
        const swatch = element('button', 'swatch', swatches);
        const vinyl = vinylFor(decal, original);
        swatch.style.background = vinyl;
        swatch.title = 'Vinyl colour';
        swatch.dataset.colour = original;
        swatch.addEventListener('click', function pick(event) {
          event.stopPropagation();
          self.popover.open(swatch, vinylChoices(doc), vinyl, function chosen(colour) {
            if (colour !== null) {
              editor.decals.setColour(decal.id, original, colour);
            }
          });
        });
      }
    }
    if (this.renaming === decal.id) {
      const input = element('input', 'rename', row);
      input.value = decal.name;
      input.spellcheck = false;
      const finish = function finish(keep: boolean): void {
        if (self.renaming !== decal.id) {
          return;
        }
        self.renaming = null;
        if (keep) {
          editor.decals.rename(decal.id, input.value);
        } else {
          self.refresh();
        }
      };
      input.addEventListener('keydown', function keys(event) {
        if (event.key === 'Enter') {
          finish(true);
        } else if (event.key === 'Escape') {
          finish(false);
        }
        event.stopPropagation();
      });
      input.addEventListener('blur', function done() {
        finish(true);
      });
      queueMicrotask(function focus() {
        input.focus();
        input.select();
      });
    } else {
      const name = element('span', 'tree-name', row);
      name.textContent = decal.name;
      name.addEventListener('dblclick', function rename(event) {
        event.stopPropagation();
        self.renaming = decal.id;
        self.refresh();
      });
    }
    const replace = element('button', 'row-button hover-only', row);
    replace.innerHTML = layerIcon('replace');
    replace.title = 'Replace artwork';
    replace.dataset.action = 'replace';
    replace.addEventListener('click', function replaceArtwork(event) {
      event.stopPropagation();
      self.replaceFile(decal.id);
    });
    const remove = element('button', 'row-button hover-only', row);
    remove.innerHTML = layerIcon('trash');
    remove.title = 'Delete (Del)';
    remove.dataset.action = 'delete';
    remove.addEventListener('click', function deleteDecal(event) {
      event.stopPropagation();
      editor.decals.select(decal.id);
      editor.decals.deleteSelected();
    });
    const lock = element('button', 'row-button lock', row);
    lock.innerHTML = layerIcon(decal.locked ? 'lock' : 'unlock');
    lock.title = decal.locked ? 'Unlock' : 'Lock';
    lock.dataset.action = 'lock';
    lock.addEventListener('click', function toggle(event) {
      event.stopPropagation();
      editor.decals.toggleLocked(decal.id);
    });
    const eye = element('button', 'row-button eye', row);
    eye.innerHTML = layerIcon(decal.hidden ? 'eyeOff' : 'eye');
    eye.title = decal.hidden ? 'Show' : 'Hide';
    eye.dataset.action = 'hide';
    eye.addEventListener('click', function toggle(event) {
      event.stopPropagation();
      editor.decals.toggleHidden(decal.id);
    });
    row.addEventListener('pointerdown', function press(event) {
      if (event.button !== 0 || (event.target as HTMLElement).closest('button, input') !== null) {
        return;
      }
      self.dragging = { id: decal.id, startY: event.clientY, moved: false, target: -1 };
    });
    row.addEventListener('click', function choose() {
      if (decal.locked || decal.hidden) {
        return;
      }
      editor.decals.select(decal.id);
    });
  }

  // While a row is dragged: where it would go, shown by a line between rows.
  private dragMove(event: PointerEvent): void {
    const drag = this.dragging;
    if (drag === null) {
      return;
    }
    if (!drag.moved) {
      if (Math.abs(event.clientY - drag.startY) < 4) {
        return;
      }
      drag.moved = true;
      this.panel.classList.add('reordering');
    }
    const rows = Array.from(this.panel.querySelectorAll('.layer-row')) as HTMLElement[];
    // Rows are listed top layer first; the gap index counts from the top.
    let gap = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) {
        gap = i;
        break;
      }
    }
    drag.target = gap;
    const panelRect = this.panel.getBoundingClientRect();
    let y = 0;
    if (rows.length > 0) {
      if (gap < rows.length) {
        y = rows[gap].getBoundingClientRect().top - panelRect.top;
      } else {
        y = rows[rows.length - 1].getBoundingClientRect().bottom - panelRect.top;
      }
    }
    this.marker.style.top = String(y + this.panel.scrollTop - 1) + 'px';
    if (this.marker.parentElement !== this.panel) {
      this.panel.appendChild(this.marker);
    }
  }

  private dragEnd(): void {
    const drag = this.dragging;
    this.dragging = null;
    this.panel.classList.remove('reordering');
    if (this.marker.parentElement !== null) {
      this.marker.parentElement.removeChild(this.marker);
    }
    if (drag === null || !drag.moved || drag.target < 0) {
      return;
    }
    const doc = this.editor.document;
    const count = doc.decals.length;
    // Gap g from the top sits above the layer count - 1 - g... convert to a
    // bottom-up index among the other decals.
    let from = -1;
    for (let i = 0; i < count; i++) {
      if (doc.decals[i].id === drag.id) {
        from = i;
      }
    }
    if (from < 0) {
      return;
    }
    const fromTop = count - 1 - from;
    let gap = drag.target;
    if (gap > fromTop) {
      gap = gap - 1; // the row itself is taken out first
    }
    const index = count - 1 - gap;
    if (index !== from) {
      this.editor.decals.setLayer(drag.id, index);
    } else {
      this.refresh();
    }
  }
}

// ---------------------------------------------------------------------------
// Export.

// The cut pieces of a document: every decal shown on a visible part.
export function cutPieces(editor: Editor): CutPiece[] {
  const doc = editor.document;
  const pieces: CutPiece[] = [];
  for (let i = 0; i < doc.decals.length; i++) {
    const decal = doc.decals[i];
    if (decal.hidden) {
      continue;
    }
    const placed = findPlaced(doc, decal.anchor.placedId);
    if (placed === null || placed.hidden) {
      continue;
    }
    const artwork = editor.decals.artworks.get(decal.artworkId);
    if (artwork === undefined) {
      continue;
    }
    pieces.push({
      name: decal.name,
      artwork: artwork,
      width: decal.width,
      height: decal.height,
      flipX: decal.flipX,
      flipY: decal.flipY,
      colourMap: decal.colourMap,
    });
  }
  return pieces;
}

function download(fileName: string, text: string): void {
  const blob = new Blob([text], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(function release() {
    URL.revokeObjectURL(url);
  }, 10000);
}

export class ExportDialog {
  readonly box: HTMLDivElement;
  private readonly editor: Editor;
  private options: CutOptions = { files: 'per-colour', overlaps: 'layered' };

  constructor(parent: HTMLElement, editor: Editor) {
    this.editor = editor;
    this.box = element('div', 'export', parent);
    this.box.style.display = 'none';
    this.build();
    const self = this;
    window.addEventListener('keydown', function escape(event) {
      if (event.key === 'Escape') {
        self.close();
      }
    });
  }

  private build(): void {
    const self = this;
    this.box.textContent = '';
    const title = element('div', 'adjust-title', this.box);
    title.textContent = 'Cut file';
    this.choice('files', [
      ['per-colour', 'A file per colour'],
      ['layers', 'One file, a layer per colour'],
    ]);
    this.choice('overlaps', [
      ['layered', 'Colours layered'],
      ['knockout', 'Overlaps knocked out'],
    ]);
    const go = element('button', 'primary', this.box);
    go.textContent = 'Export';
    go.dataset.action = 'export';
    go.addEventListener('click', function run() {
      self.run();
    });
  }

  private choice(key: 'files' | 'overlaps', values: Array<[string, string]>): void {
    const self = this;
    const group = element('div', 'segmented', this.box);
    for (let i = 0; i < values.length; i++) {
      const value = values[i][0];
      const button = element('button', '', group);
      button.textContent = values[i][1];
      button.dataset.option = key + ':' + value;
      button.classList.toggle('active', this.options[key] === value);
      button.addEventListener('click', function set() {
        if (key === 'files') {
          self.options.files = value as CutOptions['files'];
        } else {
          self.options.overlaps = value as CutOptions['overlaps'];
        }
        self.build();
      });
    }
  }

  toggle(anchor: HTMLElement): void {
    if (this.box.style.display !== 'none') {
      this.close();
      return;
    }
    this.box.style.display = '';
    const rect = anchor.getBoundingClientRect();
    const parentRect = (this.box.parentElement as HTMLElement).getBoundingClientRect();
    this.box.style.top = String(rect.bottom - parentRect.top + 6) + 'px';
    this.box.style.right = String(parentRect.right - rect.right) + 'px';
  }

  close(): void {
    this.box.style.display = 'none';
  }

  private run(): void {
    const pieces = cutPieces(this.editor);
    this.close();
    if (pieces.length === 0) {
      return;
    }
    const files = cutFiles(pieces, this.options);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      // A little apart: browsers drop downloads started in the same instant.
      setTimeout(function save() {
        download(file.fileName, file.text);
      }, i * 250);
    }
  }
}
