// The decal side of the panels: the layer list (under the rocket tree), the
// colour picker that opens from a swatch, and the export dialog. Plain DOM,
// in the same style as ui.ts; everything goes through the editor.

import type { Editor } from './editor.ts';
import type { AssemblyDocument } from '../model/document.ts';
import type { Decal } from '../model/decals.ts';
import { presetVinyl, requireDecal, vinylFor } from '../model/decals.ts';
import { cutFiles } from '../geometry/cut-export.ts';
import type { CutOptions, CutPiece } from '../geometry/cut-export.ts';
import { cutPiecesOf } from '../model/cut-pieces.ts';
import { downloadBlob, downloadText } from './downloads.ts';
import type { PagePane } from './page-pane.ts';
import type { Datum, Paper } from './exports.ts';
import { modelGlb, pageSvg, placementSheet, printablePage } from './exports.ts';

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
  private readonly editCount: (decalId: string) => void;
  private renaming: string | null = null;
  // Reordering by dragging a row.
  private dragging: { id: string; startY: number; moved: boolean; target: number } | null = null;
  private readonly marker: HTMLDivElement;

  constructor(parent: HTMLElement, editor: Editor, popover: ColourPopover, replaceFile: (decalId: string) => void, editCount: (decalId: string) => void) {
    this.editor = editor;
    this.popover = popover;
    this.replaceFile = replaceFile;
    this.editCount = editCount;
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
    // Top layer first, as in drawing programs; a linked set is one row.
    const entries = layerEntries(doc, editor.decals.selectedId);
    for (let i = 0; i < entries.length; i++) {
      this.row(doc, entries[i]);
    }
  }

  private row(doc: AssemblyDocument, entry: LayerEntry): void {
    const editor = this.editor;
    const self = this;
    const decal = entry.decal;
    const row = element('div', 'tree-row layer-row', this.panel);
    row.dataset.decalId = decal.id;
    row.dataset.count = String(entry.ids.length);
    const selectedId = editor.decals.selectedId;
    row.classList.toggle('selected', selectedId !== null && entry.ids.indexOf(selectedId) >= 0);
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
      if (entry.ids.length > 1) {
        const badge = element('span', 'badge', name);
        badge.textContent = '×' + String(entry.ids.length);
        badge.title = String(entry.ids.length) + ' linked copies; click to change how many';
        badge.dataset.action = 'count';
        badge.addEventListener('click', function count(event) {
          event.stopPropagation();
          self.editCount(decal.id);
        });
      }
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
    // The rows, top first; the dragged one comes out and goes in at the gap.
    const entries = layerEntries(doc, this.editor.decals.selectedId);
    let from = -1;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].ids.indexOf(drag.id) >= 0) {
        from = i;
      }
    }
    if (from < 0) {
      return;
    }
    let gap = drag.target;
    if (gap > from) {
      gap = gap - 1; // the row itself is taken out first
    }
    if (gap === from) {
      this.refresh();
      return;
    }
    const moving = entries[from];
    entries.splice(from, 1);
    entries.splice(gap, 0, moving);
    // Back to bottom first.
    const bottomFirst: string[] = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const ids = entries[i].ids;
      for (let k = 0; k < ids.length; k++) {
        bottomFirst.push(ids[k]);
      }
    }
    this.editor.decals.setLayers(bottomFirst);
  }
}

// One row of the layer list: a decal, or a linked set of them.
interface LayerEntry {
  // The decal the row stands for (the selected member if one is).
  decal: Decal;
  // Every member, bottom first.
  ids: string[];
}

// The rows of the layer list, top layer first. A set sits where its top
// member is.
function layerEntries(doc: AssemblyDocument, selectedId: string | null): LayerEntry[] {
  const entries: LayerEntry[] = [];
  const byGroup = new Map<string, LayerEntry>();
  for (let layer = doc.decals.length - 1; layer >= 0; layer--) {
    const decal = doc.decals[layer];
    if (decal.symmetry === null) {
      entries.push({ decal: decal, ids: [decal.id] });
      continue;
    }
    const existing = byGroup.get(decal.symmetry.group);
    if (existing === undefined) {
      const entry: LayerEntry = { decal: decal, ids: [decal.id] };
      byGroup.set(decal.symmetry.group, entry);
      entries.push(entry);
      continue;
    }
    existing.ids.unshift(decal.id);
  }
  // The row stands for the selected member, else for member 0.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    for (let k = 0; k < entry.ids.length; k++) {
      const decal = requireDecal(doc, entry.ids[k]);
      if (decal.id === selectedId) {
        entry.decal = decal;
        break;
      }
      if (decal.symmetry !== null && decal.symmetry.index === 0 && !decal.symmetry.mirrored && entry.decal.id !== selectedId) {
        entry.decal = decal;
      }
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Export.

// The cut pieces of a document: every decal shown on a visible part, linked
// copies once with a quantity.
export function cutPieces(editor: Editor): CutPiece[] {
  return cutPiecesOf(editor.document, editor.decals.artworks);
}

export class ExportDialog {
  readonly box: HTMLDivElement;
  private readonly editor: Editor;
  private readonly pagePane: PagePane;
  private options: CutOptions = { files: 'per-colour', overlaps: 'layered' };
  private paper: Paper = 'A4';
  private datum: Datum = 'aft';
  private transparent = false;

  constructor(parent: HTMLElement, editor: Editor, pagePane: PagePane) {
    this.editor = editor;
    this.pagePane = pagePane;
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
    this.heading('Cut file');
    this.choice([
      ['files:per-colour', 'A file per colour', this.options.files === 'per-colour'],
      ['files:layers', 'One file, a layer per colour', this.options.files === 'layers'],
    ]);
    this.choice([
      ['overlaps:layered', 'Colours layered', this.options.overlaps === 'layered'],
      ['overlaps:knockout', 'Overlaps knocked out', this.options.overlaps === 'knockout'],
    ]);
    const go = element('button', 'primary', this.box);
    go.textContent = 'Export cut file';
    go.dataset.action = 'export';
    go.addEventListener('click', function run() {
      self.run();
    });

    this.heading('Placement sheet');
    this.choice([
      ['paper:A4', 'A4', this.paper === 'A4'],
      ['paper:A3', 'A3', this.paper === 'A3'],
      ['datum:aft', 'From aft end', this.datum === 'aft'],
      ['datum:nose', 'From nose tip', this.datum === 'nose'],
    ]);
    const sheetRow = element('div', 'export-row', this.box);
    this.action(sheetRow, 'sheet-svg', 'Save SVG', function saveSheet() {
      self.saveSheet();
    });
    this.action(sheetRow, 'sheet-print', 'Print', function printSheet() {
      self.printSheet();
    });

    this.heading('Pictures and model');
    const pictureRow = element('div', 'export-row', this.box);
    this.action(pictureRow, 'view-png', 'View as PNG', function savePicture() {
      self.savePicture();
    });
    const transparent = element('button', 'toggle', pictureRow);
    transparent.textContent = 'Transparent';
    transparent.title = 'No background behind the rocket';
    transparent.dataset.option = 'transparent';
    transparent.classList.toggle('active', this.transparent);
    transparent.addEventListener('click', function toggle() {
      self.transparent = !self.transparent;
      self.build();
    });
    const modelRow = element('div', 'export-row', this.box);
    this.action(modelRow, 'page-svg', 'Page as SVG', function savePage() {
      self.savePage();
    });
    this.action(modelRow, 'model-glb', 'Model (.glb)', function saveModel() {
      self.saveModel();
    });
  }

  private heading(text: string): void {
    const title = element('div', 'adjust-title', this.box);
    title.textContent = text;
  }

  private action(parent: HTMLElement, name: string, label: string, run: () => void): void {
    const button = element('button', 'secondary', parent);
    button.textContent = label;
    button.dataset.action = name;
    button.addEventListener('click', run);
  }

  // A row of choices: "key:value", label, chosen.
  private choice(values: Array<[string, string, boolean]>): void {
    const self = this;
    const group = element('div', 'segmented', this.box);
    for (let i = 0; i < values.length; i++) {
      const option = values[i][0];
      const button = element('button', '', group);
      button.textContent = values[i][1];
      button.dataset.option = option;
      button.classList.toggle('active', values[i][2]);
      button.addEventListener('click', function set() {
        self.set(option);
        self.build();
      });
    }
  }

  private set(option: string): void {
    const parts = option.split(':');
    const key = parts[0];
    const value = parts[1];
    if (key === 'files') {
      this.options.files = value as CutOptions['files'];
    } else if (key === 'overlaps') {
      this.options.overlaps = value as CutOptions['overlaps'];
    } else if (key === 'paper') {
      this.paper = value as Paper;
    } else if (key === 'datum') {
      this.datum = value as Datum;
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
      this.editor.report('There are no decals to cut.');
      return;
    }
    const files = cutFiles(pieces, this.options);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      // A little apart: browsers drop downloads started in the same instant.
      setTimeout(function save() {
        downloadText(file.fileName, file.text, 'image/svg+xml');
      }, i * 250);
    }
  }

  private saveSheet(): void {
    const sheet = placementSheet(this.editor, this.pagePane, this.paper, this.datum);
    this.close();
    if (sheet === null) {
      this.editor.report('The flat page is not built yet.');
      return;
    }
    downloadText('dc6-placement-' + this.paper + '.svg', sheet.svg, 'image/svg+xml');
  }

  private printSheet(): void {
    const sheet = placementSheet(this.editor, this.pagePane, this.paper, this.datum);
    this.close();
    if (sheet === null) {
      this.editor.report('The flat page is not built yet.');
      return;
    }
    const html = printablePage(sheet, this.paper);
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const opened = window.open(url, '_blank');
    if (opened === null) {
      this.editor.report('The browser blocked the print window; save the SVG and print that.');
    }
    setTimeout(function release() {
      URL.revokeObjectURL(url);
    }, 60000);
  }

  private savePicture(): void {
    this.close();
    const editor = this.editor;
    editor.viewPicture(2, this.transparent).then(
      function made(blob) {
        downloadBlob('dc6-view.png', blob);
      },
      function failed(error: unknown) {
        editor.report(error instanceof Error ? error.message : String(error));
      },
    );
  }

  private savePage(): void {
    const svg = pageSvg(this.editor, this.pagePane);
    this.close();
    if (svg === null) {
      this.editor.report('The flat page is not built yet.');
      return;
    }
    downloadText('dc6-page.svg', svg, 'image/svg+xml');
  }

  private saveModel(): void {
    this.close();
    const editor = this.editor;
    modelGlb(editor).then(
      function made(blob) {
        downloadBlob('dc6-rocket.glb', blob);
      },
      function failed(error: unknown) {
        editor.report('Model: ' + (error instanceof Error ? error.message : String(error)));
      },
    );
  }
}
