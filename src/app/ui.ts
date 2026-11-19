// The panels around the 3D view: toolbar, parts list, rocket tree,
// inspector, empty state. Plain DOM; everything they do goes through the
// editor.

import * as THREE from 'three';
import type { Editor, Tool } from './editor.ts';
import type { PresetView } from './view.ts';
import type { AssemblyDocument, PlacedPart } from '../model/document.ts';
import { findPlaced, requirePlaced, symmetryMembers } from '../model/document.ts';
import { renderThumbnail } from './thumbnails.ts';

// Stroke icons, 20 x 20 view box.
const icons: Record<string, string> = {
  place: '<path d="M5 3l11 7-5 1.2L8.6 17z"/>',
  move: '<path d="M10 2v16M2 10h16M10 2l-2.5 2.5M10 2l2.5 2.5M10 18l-2.5-2.5M10 18l2.5-2.5M2 10l2.5-2.5M2 10l2.5 2.5M18 10l-2.5-2.5M18 10l-2.5 2.5"/>',
  rotate: '<path d="M16 10a6 6 0 1 1-1.8-4.3"/><path d="M15 2.5v3.6h-3.6"/>',
  face: '<path d="M4 7l6-3.5L16 7v6l-6 3.5L4 13z"/><path d="M4 13l6 3.5 6-3.5-6-3z" fill="currentColor" fill-opacity="0.45"/>',
  undo: '<path d="M7 5L3 9l4 4"/><path d="M3 9h9a5 5 0 0 1 0 10h-2"/>',
  redo: '<path d="M13 5l4 4-4 4"/><path d="M17 9H8a5 5 0 0 0 0 10h2"/>',
  eye: '<path d="M1.5 10S5 4 10 4s8.5 6 8.5 6-3.5 6-8.5 6-8.5-6-8.5-6z"/><circle cx="10" cy="10" r="2.5"/>',
  eyeOff: '<path d="M1.5 10S5 4 10 4s8.5 6 8.5 6-3.5 6-8.5 6-8.5-6-8.5-6z" opacity="0.35"/><path d="M3 17L17 3"/>',
  trash: '<path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
};

function icon(name: string): string {
  return '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + icons[name] + '</svg>';
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement | null): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  if (className !== '') {
    created.className = className;
  }
  if (parent !== null) {
    parent.appendChild(created);
  }
  return created;
}

interface PendingFile {
  name: string;
}

export class Ui {
  private readonly editor: Editor;
  private readonly root: HTMLElement;
  private readonly topbar: HTMLElement;
  private readonly bin: HTMLElement;
  private readonly binList: HTMLElement;
  private readonly tree: HTMLElement;
  private readonly inspector: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  private readonly symmetryButton: HTMLButtonElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  private readonly thumbnails = new Map<string, string>();
  private readonly pending: PendingFile[] = [];
  private inspectorFor: string | null = null;
  private readonly inputs: HTMLInputElement[] = [];
  // The text last written into each input, to tell which ones the user changed.
  private readonly shownTexts: string[] = [];
  private toastTimer = 0;
  private refreshQueued = false;

  constructor(root: HTMLElement, editor: Editor, openFiles: (files: File[]) => void) {
    this.editor = editor;
    this.root = root;
    const self = this;

    this.fileInput = element('input', '', root);
    this.fileInput.type = 'file';
    this.fileInput.multiple = true;
    this.fileInput.accept = '.step,.stp,.STEP,.STP';
    this.fileInput.style.display = 'none';
    this.fileInput.addEventListener('change', function picked() {
      const files = Array.from(self.fileInput.files ?? []);
      self.fileInput.value = '';
      openFiles(files);
    });

    // Empty state: the only thing on screen until a file arrives.
    this.empty = element('div', 'empty', root);
    const emptyTitle = element('div', 'empty-title', this.empty);
    emptyTitle.textContent = 'Drop STEP files here';
    const choose = element('button', 'link', this.empty);
    choose.textContent = 'or choose files';
    choose.addEventListener('click', function chooseFiles() {
      self.fileInput.click();
    });

    // Toolbar.
    this.topbar = element('div', 'topbar', root);
    const tools = element('div', 'group', this.topbar);
    const toolList: Array<[Tool, string, string]> = [
      ['place', 'place', 'Place (1)'],
      ['move', 'move', 'Move along the axis (2) · Ctrl: any direction · Shift: 0.1 mm'],
      ['rotate', 'rotate', 'Rotate (3) · 15° steps · Shift: 1°'],
      ['face', 'face', 'Place on face (F)'],
    ];
    for (let i = 0; i < toolList.length; i++) {
      const tool = toolList[i][0];
      const button = element('button', 'tool', tools);
      button.innerHTML = icon(toolList[i][1]);
      button.title = toolList[i][2];
      button.dataset.tool = tool;
      button.addEventListener('click', function chooseTool() {
        editor.setTool(tool);
      });
      this.toolButtons.set(tool, button);
    }
    const options = element('div', 'group', this.topbar);
    this.symmetryButton = element('button', 'tool text', options);
    this.symmetryButton.title = 'Symmetry (X, Shift+X)';
    this.symmetryButton.dataset.control = 'symmetry';
    this.symmetryButton.addEventListener('click', function nextSymmetry(event) {
      editor.stepSymmetry(event.shiftKey ? -1 : 1);
    });
    this.symmetryButton.addEventListener('contextmenu', function previousSymmetry(event) {
      event.preventDefault();
      editor.stepSymmetry(-1);
    });
    const history = element('div', 'group', this.topbar);
    this.undoButton = element('button', 'tool', history);
    this.undoButton.innerHTML = icon('undo');
    this.undoButton.title = 'Undo (Ctrl+Z)';
    this.undoButton.addEventListener('click', function undo() {
      editor.undo();
    });
    this.redoButton = element('button', 'tool', history);
    this.redoButton.innerHTML = icon('redo');
    this.redoButton.title = 'Redo (Ctrl+Shift+Z)';
    this.redoButton.addEventListener('click', function redo() {
      editor.redo();
    });
    element('div', 'spacer', this.topbar);
    const views = element('div', 'group views', this.topbar);
    const viewList: Array<[PresetView | 'fit', string]> = [
      ['side', 'Side'],
      ['top', 'Top'],
      ['nose', 'Nose'],
      ['tail', 'Tail'],
      ['fit', 'Fit'],
    ];
    for (let i = 0; i < viewList.length; i++) {
      const preset = viewList[i][0];
      const button = element('button', 'view', views);
      button.textContent = viewList[i][1];
      button.dataset.view = preset;
      button.addEventListener('click', function chooseView() {
        editor.setView(preset);
      });
    }

    // Parts list: a slim column over the left edge of the view.
    this.bin = element('div', 'bin', root);
    const add = element('button', 'bin-add', this.bin);
    add.innerHTML = icon('plus');
    add.title = 'Add STEP files';
    add.addEventListener('click', function addFiles() {
      self.fileInput.click();
    });
    this.binList = element('div', 'bin-list', this.bin);

    this.tree = element('div', 'tree', root);
    this.inspector = element('div', 'inspector', root);
    this.toast = element('div', 'toast', root);

    // Drag and drop anywhere in the window.
    let dragDepth = 0;
    window.addEventListener('dragenter', function enter(event) {
      if (!hasFiles(event)) {
        return;
      }
      event.preventDefault();
      dragDepth = dragDepth + 1;
      root.classList.add('dropping');
    });
    window.addEventListener('dragover', function over(event) {
      if (hasFiles(event)) {
        event.preventDefault();
      }
    });
    window.addEventListener('dragleave', function leave() {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        root.classList.remove('dropping');
      }
    });
    window.addEventListener('drop', function drop(event) {
      event.preventDefault();
      dragDepth = 0;
      root.classList.remove('dropping');
      const files = Array.from(event.dataTransfer?.files ?? []);
      openFiles(files);
    });

    editor.addListener({
      changed: function changed() {
        self.queueRefresh();
      },
    });
    this.refresh();
  }

  addPending(name: string): PendingFile {
    const entry = { name: name };
    this.pending.push(entry);
    this.refresh();
    return entry;
  }

  removePending(entry: PendingFile): void {
    const index = this.pending.indexOf(entry);
    if (index >= 0) {
      this.pending.splice(index, 1);
    }
    this.refresh();
  }

  showError(message: string): void {
    this.toast.textContent = message;
    this.toast.classList.add('visible');
    window.clearTimeout(this.toastTimer);
    const toast = this.toast;
    this.toastTimer = window.setTimeout(function hide() {
      toast.classList.remove('visible');
    }, 6000);
  }

  private queueRefresh(): void {
    if (this.refreshQueued) {
      return;
    }
    this.refreshQueued = true;
    const self = this;
    queueMicrotask(function refreshSoon() {
      self.refreshQueued = false;
      self.refresh();
    });
  }

  refresh(): void {
    const editor = this.editor;
    const hasParts = editor.partOrder.length > 0 || this.pending.length > 0;
    this.root.classList.toggle('has-parts', hasParts);
    this.empty.style.display = hasParts ? 'none' : '';
    this.topbar.style.display = hasParts ? '' : 'none';
    this.bin.style.display = hasParts ? '' : 'none';

    this.toolButtons.forEach(function mark(button, tool) {
      button.classList.toggle('active', editor.tool === tool);
    });
    this.symmetryButton.textContent = '×' + String(editor.symmetryCount);
    this.symmetryButton.classList.toggle('active', editor.symmetryCount > 1);
    this.undoButton.disabled = !editor.history.canUndo();
    this.redoButton.disabled = !editor.history.canRedo();

    this.refreshBin();
    this.refreshTree();
    this.refreshInspector();
  }

  private refreshBin(): void {
    const editor = this.editor;
    const list = this.binList;
    list.textContent = '';
    const heldPart = editor.heldPartId();
    for (let i = 0; i < editor.partOrder.length; i++) {
      const partId = editor.partOrder[i];
      const part = editor.parts.get(partId);
      if (part === undefined) {
        continue;
      }
      const item = element('div', 'bin-item', list);
      item.dataset.partId = partId;
      item.dataset.partName = part.name;
      item.title = part.name;
      item.classList.toggle('held', heldPart === partId && editor.isHolding());
      let url = this.thumbnails.get(partId);
      if (url === undefined) {
        url = renderThumbnail(part, editor.holdingTransform(partId));
        this.thumbnails.set(partId, url);
      }
      const image = element('img', '', item);
      image.src = url;
      image.alt = '';
      image.draggable = false;
      const label = element('div', 'bin-name', item);
      label.textContent = part.name;
      item.addEventListener('pointerdown', function pick(event) {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        editor.pickNew(partId);
      });
    }
    for (let i = 0; i < this.pending.length; i++) {
      const item = element('div', 'bin-item loading', list);
      element('div', 'bin-placeholder', item);
      const label = element('div', 'bin-name', item);
      label.textContent = this.pending[i].name.replace(/\.(step|stp)$/i, '');
    }
  }

  private refreshTree(): void {
    const editor = this.editor;
    const doc = editor.document;
    this.tree.textContent = '';
    this.tree.style.display = doc.placed.length > 0 ? '' : 'none';
    const rows = treeRows(doc);
    for (let i = 0; i < rows.length; i++) {
      const placed = rows[i].placed;
      const part = editor.parts.get(placed.partId);
      const row = element('div', 'tree-row', this.tree);
      row.dataset.placedId = placed.id;
      row.style.paddingLeft = String(8 + rows[i].depth * 12) + 'px';
      const selected = editor.selectedId !== null && sameSet(doc, editor.selectedId, placed.id);
      row.classList.toggle('selected', selected);
      row.classList.toggle('hidden-part', placed.hidden);
      const name = element('span', 'tree-name', row);
      let text = part === undefined ? placed.partId : part.name;
      if (placed.symmetry !== null) {
        text = text + ' ×' + String(placed.symmetry.count);
      }
      name.textContent = text;
      const eye = element('button', 'eye', row);
      eye.innerHTML = icon(placed.hidden ? 'eyeOff' : 'eye');
      eye.title = placed.hidden ? 'Show' : 'Hide';
      eye.addEventListener('click', function toggle(event) {
        event.stopPropagation();
        editor.toggleHidden(placed.id);
      });
      row.addEventListener('click', function choose() {
        editor.select(placed.id);
      });
    }
  }

  private refreshInspector(): void {
    const editor = this.editor;
    const selectedId = editor.selectedId;
    const shown = editor.shownDocument;
    if (selectedId === null || editor.isHolding()) {
      this.inspector.style.display = 'none';
      this.inspectorFor = null;
      return;
    }
    const placed = findPlaced(shown, selectedId);
    if (placed === null) {
      this.inspector.style.display = 'none';
      return;
    }
    this.inspector.style.display = '';
    if (this.inspectorFor !== selectedId) {
      this.buildInspector(placed);
      this.inspectorFor = selectedId;
    }
    this.fillInspector(false);
  }

  // Fill in the numbers; a field the user is typing in is left alone unless
  // `force` is set.
  private fillInspector(force: boolean): void {
    const editor = this.editor;
    const pivot = editor.selectedPivot();
    if (pivot === null || editor.selectedId === null) {
      return;
    }
    const placed = requirePlaced(editor.shownDocument, editor.selectedId);
    const values = placementToFields(pivot, placed);
    for (let i = 0; i < this.inputs.length; i++) {
      if (force || document.activeElement !== this.inputs[i]) {
        const text = values[i].toFixed(i < 3 ? 2 : 1);
        this.inputs[i].value = text;
        this.shownTexts[i] = text;
      }
    }
  }

  private buildInspector(placed: PlacedPart): void {
    const editor = this.editor;
    const self = this;
    this.inspector.textContent = '';
    this.inputs.length = 0;
    const header = element('div', 'inspector-header', this.inspector);
    const title = element('span', 'inspector-title', header);
    const part = editor.parts.get(placed.partId);
    title.textContent = part === undefined ? placed.partId : part.name;
    const remove = element('button', 'icon-button', header);
    remove.innerHTML = icon('trash');
    remove.title = 'Delete (Del)';
    remove.addEventListener('click', function deletePart() {
      editor.deleteSelected();
    });
    const rows: Array<[string, string]> = [
      ['Position', 'mm'],
      ['Rotation', '°'],
    ];
    for (let r = 0; r < rows.length; r++) {
      const row = element('div', 'inspector-row', this.inspector);
      const label = element('span', 'inspector-label', row);
      label.textContent = rows[r][0];
      const axes = ['X', 'Y', 'Z'];
      for (let a = 0; a < 3; a++) {
        const field = element('label', 'field', row);
        const axis = element('span', 'axis', field);
        axis.textContent = axes[a];
        const input = element('input', '', field);
        input.type = 'text';
        input.inputMode = 'decimal';
        input.spellcheck = false;
        input.addEventListener('change', function apply() {
          self.applyInspector();
        });
        input.addEventListener('keydown', function enter(event) {
          if (event.key === 'Enter') {
            input.blur();
          }
        });
        this.inputs.push(input);
      }
      const unit = element('span', 'unit', row);
      unit.textContent = rows[r][1];
    }
  }

  // Apply what the user typed. Only fields the user changed are read: the
  // others keep their exact values, so typing a position does not round the
  // rotation to the one decimal shown (that would tip a part off the axis).
  private applyInspector(): void {
    const editor = this.editor;
    const pivot = editor.selectedPivot();
    if (pivot === null || editor.selectedId === null) {
      return;
    }
    const placed = requirePlaced(editor.shownDocument, editor.selectedId);
    const values = placementToFields(pivot, placed);
    let rotationChanged = false;
    for (let i = 0; i < this.inputs.length; i++) {
      if (this.inputs[i].value === this.shownTexts[i]) {
        continue;
      }
      const value = evaluateSum(this.inputs[i].value);
      if (value === null) {
        // Not a number: put the real values back.
        this.fillInspector(true);
        return;
      }
      values[i] = value;
      if (i >= 3) {
        rotationChanged = true;
      }
    }
    let rotation = placed.transform.rotation;
    if (rotationChanged) {
      const euler = new THREE.Euler((values[3] * Math.PI) / 180, (values[4] * Math.PI) / 180, (values[5] * Math.PI) / 180, 'XYZ');
      const quaternion = new THREE.Quaternion().setFromEuler(euler);
      rotation = [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
    }
    editor.setSelectedPlacement([values[0], values[1], values[2]], rotation);
  }
}

// The inspector shows where the middle of the part is (the point the gizmos
// sit on) and the part's rotation as X, Y, Z angles.
function placementToFields(pivot: [number, number, number], placed: PlacedPart): number[] {
  const q = placed.transform.rotation;
  const euler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]), 'XYZ');
  const degrees = 180 / Math.PI;
  return [pivot[0], pivot[1], pivot[2], euler.x * degrees, euler.y * degrees, euler.z * degrees];
}

// A field may hold a number or a sum such as "-130+12", so a part can be
// pushed 12 mm by typing "+12" after the value that is there.
export function evaluateSum(text: string): number | null {
  const cleaned = text.replace(/\s+/g, '').replace(/,/g, '.').replace(/\u2212/g, '-');
  const wholePattern = /^[+-]?(\d+\.?\d*|\.\d+)([+-](\d+\.?\d*|\.\d+))*$/;
  if (!wholePattern.test(cleaned)) {
    return null;
  }
  const termPattern = /[+-]?(\d+\.?\d*|\.\d+)/g;
  const terms = cleaned.match(termPattern);
  if (terms === null) {
    return null;
  }
  let total = 0;
  for (let i = 0; i < terms.length; i++) {
    total = total + Number(terms[i]);
  }
  return total;
}

function hasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  if (types === undefined) {
    return false;
  }
  return Array.from(types).includes('Files');
}

function sameSet(doc: AssemblyDocument, a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const members = symmetryMembers(doc, a);
  for (let i = 0; i < members.length; i++) {
    if (members[i].id === b) {
      return true;
    }
  }
  return false;
}

// Rows for the rocket tree: depth first from the root, then free parts. A
// symmetry set shows as one row (its first member).
function treeRows(doc: AssemblyDocument): Array<{ placed: PlacedPart; depth: number }> {
  const rows: Array<{ placed: PlacedPart; depth: number }> = [];
  const listedGroups = new Set<string>();
  const visited = new Set<string>();
  function visit(placed: PlacedPart, depth: number): void {
    if (visited.has(placed.id)) {
      return;
    }
    visited.add(placed.id);
    let listed = true;
    if (placed.symmetry !== null) {
      if (listedGroups.has(placed.symmetry.group)) {
        listed = false;
      }
      listedGroups.add(placed.symmetry.group);
    }
    if (listed) {
      rows.push({ placed: placed, depth: depth });
    }
    for (let i = 0; i < doc.placed.length; i++) {
      if (doc.placed[i].parentId === placed.id) {
        visit(doc.placed[i], depth + 1);
      }
    }
  }
  for (let i = 0; i < doc.placed.length; i++) {
    if (doc.placed[i].id === doc.rootId) {
      visit(doc.placed[i], 0);
    }
  }
  for (let i = 0; i < doc.placed.length; i++) {
    if (doc.placed[i].parentId === null) {
      visit(doc.placed[i], 0);
    }
  }
  return rows;
}
