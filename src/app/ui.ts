// The panels around the 3D view: toolbar, parts list, rocket tree, the
// adjust-last-operation panel, empty state. Plain DOM; everything they do goes through the
// editor.

import type { Editor, LastOperation, Tool } from './editor.ts';
import type { PresetView } from './view.ts';
import type { PagePane } from './page-pane.ts';
import type { AssemblyDocument, PlacedPart } from '../model/document.ts';
import { symmetryMembers } from '../model/document.ts';
import { renderThumbnail } from './thumbnails.ts';
import { ColourPopover, ExportDialog, LayerList } from './decal-panels.ts';
import type { ColourChoice } from './decal-panels.ts';
import { presetVinyl } from '../model/decals.ts';
import { drawArtwork } from './decal-visuals.ts';
import type { Artwork } from '../geometry/artwork.ts';
import type { ReattachReport } from '../model/replace-part.ts';

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
  flipX: '<path d="M10 3v14" stroke-dasharray="2 2"/><path d="M7 6L3 10l4 4zM13 6l4 4-4 4z"/>',
  flipY: '<path d="M3 10h14" stroke-dasharray="2 2"/><path d="M6 7l4-4 4 4zM6 13l4 4 4-4z"/>',
  replace: '<path d="M4 8a6 6 0 0 1 11-2M16 12a6 6 0 0 1-11 2"/><path d="M15 2.5V6h-3.5M5 17.5V14h3.5"/>',
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

// What the panels ask the rest of the app to do with files.
export interface UiActions {
  openFiles(files: File[]): void;
  save(): void;
  newProject(): void;
  // There is work that is not in a saved project file.
  unsavedWork(): boolean;
  // Replace the part a placed part is made from by a revised STEP file.
  replacePart(placedId: string, file: File): void;
}

export class Ui {
  private readonly editor: Editor;
  private readonly root: HTMLElement;
  private readonly topbar: HTMLElement;
  private readonly bin: HTMLElement;
  private readonly binList: HTMLElement;
  private readonly tree: HTMLElement;
  private readonly layers: LayerList;
  private readonly popover: ColourPopover;
  private readonly exportDialog: ExportDialog;
  private readonly exportGroup: HTMLElement;
  private readonly decalGroup: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly noticeText: HTMLElement;
  private readonly replaceInput: HTMLInputElement;
  private replaceTarget: string | null = null;
  private readonly artThumbnails = new WeakMap<object, string>();
  private readonly adjust: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  private readonly symmetryButton: HTMLButtonElement;
  private readonly decalButtons = new Map<string, HTMLButtonElement>();
  private readonly countInput: HTMLInputElement;
  private readonly openButton: HTMLButtonElement;
  private pendingOpen: (() => void) | null = null;
  private openArmedTimer = 0;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  // By object, not id: a project opened later may reuse an id.
  private readonly thumbnails = new WeakMap<object, string>();
  private readonly actions: UiActions;
  private readonly openInput: HTMLInputElement;
  private readonly stepInput: HTMLInputElement;
  private replacePartTarget: string | null = null;
  private readonly newButton: HTMLButtonElement;
  private newArmedTimer = 0;
  // The two halves of the left column, folded away or not.
  private partsFolded = false;
  private artFolded = false;
  private readonly pending: PendingFile[] = [];
  private adjustFor: LastOperation | null = null;
  private readonly adjustInputs: HTMLInputElement[] = [];
  private toastTimer = 0;
  private refreshQueued = false;

  constructor(root: HTMLElement, editor: Editor, pagePane: PagePane, actions: UiActions) {
    this.editor = editor;
    this.root = root;
    this.actions = actions;
    const openFiles = actions.openFiles;
    const self = this;
    this.partsFolded = readFlag('dc6.partsFolded');
    this.artFolded = readFlag('dc6.artFolded');

    this.fileInput = element('input', '', root);
    this.fileInput.type = 'file';
    this.fileInput.multiple = true;
    this.fileInput.accept = '.step,.stp,.STEP,.STP,.svg,.SVG,.dc6';
    this.fileInput.style.display = 'none';
    this.fileInput.addEventListener('change', function picked() {
      const files = Array.from(self.fileInput.files ?? []);
      self.fileInput.value = '';
      openFiles(files);
    });
    this.fileInput.dataset.input = 'add';

    // Open a project, and a revised STEP file for a part.
    this.openInput = element('input', '', root);
    this.openInput.type = 'file';
    this.openInput.accept = '.dc6';
    this.openInput.style.display = 'none';
    this.openInput.dataset.input = 'open';
    this.openInput.addEventListener('change', function picked() {
      const files = Array.from(self.openInput.files ?? []);
      self.openInput.value = '';
      openFiles(files);
    });
    this.stepInput = element('input', '', root);
    this.stepInput.type = 'file';
    this.stepInput.accept = '.step,.stp,.STEP,.STP';
    this.stepInput.style.display = 'none';
    this.stepInput.dataset.input = 'replace-part';
    this.stepInput.addEventListener('change', function picked() {
      const files = Array.from(self.stepInput.files ?? []);
      self.stepInput.value = '';
      const target = self.replacePartTarget;
      self.replacePartTarget = null;
      if (files.length > 0 && target !== null) {
        actions.replacePart(target, files[0]);
      }
    });

    // Empty state: the only thing on screen until a file arrives.
    this.empty = element('div', 'empty', root);
    const emptyTitle = element('div', 'empty-title', this.empty);
    emptyTitle.textContent = 'Drop STEP and SVG files here';
    const emptyOpen = element('button', 'link', this.empty);
    emptyOpen.textContent = 'or open a project';
    emptyOpen.dataset.control = 'open-empty';
    emptyOpen.addEventListener('click', function openProject() {
      self.openInput.click();
    });
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
      if (editor.decals.selectedSymmetry() !== null) {
        // A decal: type how many copies (X and Shift+X still step).
        self.editCount();
        return;
      }
      editor.stepSymmetry(event.shiftKey ? -1 : 1);
    });
    this.countInput = element('input', 'count-input', options);
    this.countInput.type = 'text';
    this.countInput.inputMode = 'numeric';
    this.countInput.spellcheck = false;
    this.countInput.dataset.control = 'symmetry-count';
    this.countInput.title = 'Copies round the rocket, 1 to 12; Enter';
    this.countInput.style.display = 'none';
    this.countInput.addEventListener('keydown', function keys(event) {
      if (event.key === 'Enter') {
        const count = Number(self.countInput.value.trim());
        if (Number.isInteger(count) && count >= 1 && count <= 12) {
          editor.decals.setSymmetryCount(count);
        }
        self.closeCount();
      } else if (event.key === 'Escape') {
        self.closeCount();
      }
      event.stopPropagation();
    });
    this.countInput.addEventListener('blur', function done() {
      self.closeCount();
    });
    this.symmetryButton.addEventListener('contextmenu', function previousSymmetry(event) {
      event.preventDefault();
      editor.stepSymmetry(-1);
    });
    // Shown while a decal is selected: flip it (H, V).
    this.decalGroup = element('div', 'group', this.topbar);
    const flips: Array<['x' | 'y', string, string]> = [
      ['x', 'flipX', 'Flip horizontally (H)'],
      ['y', 'flipY', 'Flip vertically (V)'],
    ];
    for (let i = 0; i < flips.length; i++) {
      const axis = flips[i][0];
      const button = element('button', 'tool', this.decalGroup);
      button.innerHTML = icon(flips[i][1]);
      button.title = flips[i][2];
      button.dataset.control = 'flip-' + axis;
      button.addEventListener('click', function flip() {
        editor.decals.flipSelected(axis);
      });
    }
    // Decal symmetry, beside the flips (the ×N button is shared with parts).
    const decalCommands: Array<[string, string, string, () => void]> = [
      ['decal-mirror', 'Mirror', 'A mirror image on the other side (M)', function mirror() {
        editor.decals.toggleMirror();
      }],
      ['decal-flip-mirror', 'Flip image', 'Mirror images show the artwork mirrored', function flipImage() {
        editor.decals.toggleFlipMirror();
      }],
      ['decal-every-fin', 'Every fin', 'A copy on every fin of the set, same place, same side', function everyFin() {
        editor.decals.onEveryFin();
      }],
      ['decal-unique', 'Make unique', 'Unlink this copy from the others', function unique() {
        editor.decals.makeUnique();
      }],
    ];
    for (let i = 0; i < decalCommands.length; i++) {
      const command = decalCommands[i];
      const button = element('button', 'tool text words', this.decalGroup);
      button.textContent = command[1];
      button.title = command[2];
      button.dataset.control = command[0];
      button.addEventListener('click', command[3]);
      this.decalButtons.set(command[0], button);
    }
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
    // The project: as KSP's editor, three plain buttons.
    const files = element('div', 'group', this.topbar);
    this.newButton = element('button', 'view', files);
    this.newButton.textContent = 'New';
    this.newButton.title = 'Start again (cannot be undone)';
    this.newButton.dataset.control = 'new';
    this.newButton.addEventListener('click', function startAgain() {
      self.newClicked();
    });
    const openButton = element('button', 'view', files);
    this.openButton = openButton;
    openButton.textContent = 'Open';
    openButton.title = 'Open a project (Ctrl+O)';
    openButton.dataset.control = 'open';
    openButton.addEventListener('click', function openProject() {
      self.askThenOpen(function pick() {
        self.openInput.click();
      });
    });
    const saveButton = element('button', 'view', files);
    saveButton.textContent = 'Save';
    saveButton.title = 'Save the project as one .dc6 file (Ctrl+S)';
    saveButton.dataset.control = 'save';
    saveButton.addEventListener('click', function saveProject() {
      actions.save();
    });
    this.exportGroup = element('div', 'group', this.topbar);
    const exportButton = element('button', 'view', this.exportGroup);
    exportButton.textContent = 'Export';
    exportButton.dataset.control = 'export';
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
    add.title = 'Add STEP or SVG files';
    add.addEventListener('click', function addFiles() {
      self.fileInput.click();
    });
    this.binList = element('div', 'bin-list', this.bin);

    // The right-hand column: the rocket tree, and the decals as layers under it.
    const side = element('div', 'side', root);
    this.tree = element('div', 'tree', side);
    this.popover = new ColourPopover(root);
    this.replaceInput = element('input', '', root);
    this.replaceInput.type = 'file';
    this.replaceInput.accept = '.svg,.SVG';
    this.replaceInput.style.display = 'none';
    this.replaceInput.addEventListener('change', function picked() {
      const files = Array.from(self.replaceInput.files ?? []);
      self.replaceInput.value = '';
      const target = self.replaceTarget;
      self.replaceTarget = null;
      if (files.length > 0 && target !== null) {
        self.replaceArtwork(target, files[0]);
      }
    });
    this.layers = new LayerList(
      side,
      editor,
      this.popover,
      function chooseReplacement(decalId: string) {
        self.replaceTarget = decalId;
        self.replaceInput.click();
      },
      function editCount(decalId: string) {
        editor.decals.select(decalId);
        editor.notify();
        self.editCount();
      },
    );
    this.exportDialog = new ExportDialog(root, editor, pagePane);
    exportButton.addEventListener('click', function openExport() {
      self.exportDialog.toggle(exportButton);
    });
    this.adjust = element('div', 'adjust', root);
    this.toast = element('div', 'toast', root);
    // A notice about an imported file: stays until dismissed.
    this.notice = element('div', 'notice', root);
    this.noticeText = element('span', '', this.notice);
    const dismiss = element('button', 'notice-close', this.notice);
    dismiss.textContent = '×';
    dismiss.title = 'Dismiss';
    dismiss.addEventListener('click', function close() {
      self.notice.style.display = 'none';
    });
    this.notice.style.display = 'none';

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
    editor.onReport(function reported(text: string) {
      self.showError(text);
    });
    window.addEventListener('keydown', function fileKeys(event) {
      const command = event.ctrlKey || event.metaKey;
      if (!command) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        actions.save();
      } else if (key === 'o') {
        event.preventDefault();
        self.askThenOpen(function pick() {
          self.openInput.click();
        });
      }
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

  // Problems with an imported file the user should know about.
  showNotice(lines: string[]): void {
    if (lines.length === 0) {
      return;
    }
    this.noticeText.textContent = lines.join(' ');
    this.notice.style.display = '';
  }

  private replaceArtwork(decalId: string, file: File): void {
    const self = this;
    file.text().then(function read(text) {
      try {
        const result = self.editor.decals.addArtwork(text, file.name);
        self.showNotice(result.notices);
        if (result.artwork !== null) {
          self.editor.decals.replaceArtwork(decalId, result.artwork);
        }
      } catch (error) {
        self.showError(file.name + ': ' + (error instanceof Error ? error.message : String(error)));
      }
    });
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
    const hasParts = editor.partOrder.length > 0 || this.pending.length > 0 || editor.decals.artworkOrder.length > 0;
    this.root.classList.toggle('has-parts', hasParts);
    this.empty.style.display = hasParts ? 'none' : '';
    this.topbar.style.display = hasParts ? '' : 'none';
    this.bin.style.display = hasParts ? '' : 'none';

    this.toolButtons.forEach(function mark(button, tool) {
      button.classList.toggle('active', editor.tool === tool);
    });
    const decalSymmetry = editor.decals.selectedSymmetry();
    if (decalSymmetry !== null) {
      // A decal is selected: ×N is its copies round the rocket.
      this.symmetryButton.textContent = '×' + String(decalSymmetry.count);
      this.symmetryButton.classList.toggle('active', decalSymmetry.count > 1);
      this.symmetryButton.title = 'Copies of the decal round the rocket (X, Shift+X)';
    } else {
      this.symmetryButton.textContent = '×' + String(editor.symmetryCount);
      this.symmetryButton.classList.toggle('active', editor.symmetryCount > 1);
      this.symmetryButton.title = 'Symmetry (X, Shift+X)';
    }
    this.decalGroup.style.display = decalSymmetry !== null ? '' : 'none';
    if (decalSymmetry !== null) {
      const mirror = this.decalButtons.get('decal-mirror') as HTMLButtonElement;
      mirror.classList.toggle('active', decalSymmetry.mirror);
      const flipImage = this.decalButtons.get('decal-flip-mirror') as HTMLButtonElement;
      flipImage.style.display = decalSymmetry.mirror ? '' : 'none';
      flipImage.classList.toggle('active', decalSymmetry.flipMirror);
      const everyFin = this.decalButtons.get('decal-every-fin') as HTMLButtonElement;
      everyFin.style.display = decalSymmetry.onFin > 1 && decalSymmetry.count !== decalSymmetry.onFin ? '' : 'none';
      const unique = this.decalButtons.get('decal-unique') as HTMLButtonElement;
      unique.style.display = decalSymmetry.members > 1 ? '' : 'none';
    }
    this.exportGroup.style.display = editor.document.placed.length > 0 ? '' : 'none';
    this.undoButton.disabled = !editor.history.canUndo();
    this.redoButton.disabled = !editor.history.canRedo();

    this.refreshBin();
    this.refreshTree();
    this.layers.refresh();
    this.refreshAdjust();
  }

  private refreshBin(): void {
    const editor = this.editor;
    const list = this.binList;
    const self = this;
    list.textContent = '';
    const decals = editor.decals;
    // Two halves, each under a heading that folds it away.
    const hasParts = editor.partOrder.length > 0 || this.pending.length > 0;
    const hasArt = decals.artworkOrder.length > 0;
    if (hasParts && hasArt) {
      this.binHeading(list, 'Parts', 'parts', this.partsFolded, editor.partOrder.length + this.pending.length, function fold() {
        self.partsFolded = !self.partsFolded;
        writeFlag('dc6.partsFolded', self.partsFolded);
        self.refresh();
      });
    }
    const heldPart = editor.heldPartId();
    const showParts = !(hasParts && hasArt && this.partsFolded);
    for (let i = 0; i < editor.partOrder.length && showParts; i++) {
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
      let url = this.thumbnails.get(part);
      if (url === undefined) {
        url = renderThumbnail(part, editor.holdingTransform(partId));
        this.thumbnails.set(part, url);
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
    for (let i = 0; i < this.pending.length && showParts; i++) {
      const item = element('div', 'bin-item loading', list);
      element('div', 'bin-placeholder', item);
      const label = element('div', 'bin-name', item);
      label.textContent = this.pending[i].name.replace(/\.(step|stp|dc6)$/i, '');
    }
    // The imported artwork, below the parts: click one and it follows the
    // cursor over the rocket, stuck to the surface, until a click drops it.
    if (hasParts && hasArt) {
      this.binHeading(list, 'Artwork', 'artwork', this.artFolded, decals.artworkOrder.length, function fold() {
        self.artFolded = !self.artFolded;
        writeFlag('dc6.artFolded', self.artFolded);
        self.refresh();
      });
    }
    const showArt = !(hasParts && hasArt && this.artFolded);
    const heldArt = decals.heldArtworkId();
    for (let i = 0; i < decals.artworkOrder.length && showArt; i++) {
      const artworkId = decals.artworkOrder[i];
      const artwork = decals.requireArtwork(artworkId);
      const item = element('div', 'bin-item art-item', list);
      item.dataset.artworkId = artworkId;
      item.dataset.artworkName = artwork.name;
      item.title = artwork.name + ' · ' + artwork.width.toFixed(1) + ' × ' + artwork.height.toFixed(1) + ' mm';
      item.classList.toggle('held', heldArt === artworkId);
      let url = this.artThumbnails.get(artwork);
      if (url === undefined) {
        url = artworkThumbnail(artwork);
        this.artThumbnails.set(artwork, url);
      }
      const image = element('img', '', item);
      image.src = url;
      image.alt = '';
      image.draggable = false;
      const label = element('div', 'bin-name', item);
      label.textContent = artwork.name;
      item.addEventListener('pointerdown', function pick(event) {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        decals.pickArtwork(artworkId);
      });
    }
  }

  // A heading in the left column: its name, a count when folded, and a
  // click folds or unfolds what is under it.
  private binHeading(list: HTMLElement, text: string, key: string, folded: boolean, count: number, toggle: () => void): void {
    const heading = element('button', 'bin-heading', list);
    heading.dataset.heading = key;
    heading.classList.toggle('folded', folded);
    heading.title = folded ? 'Show' : 'Fold away';
    const arrow = element('span', 'bin-arrow', heading);
    arrow.textContent = folded ? '▸' : '▾';
    const name = element('span', '', heading);
    name.textContent = folded ? text + ' ' + String(count) : text;
    heading.addEventListener('click', toggle);
  }

  // ×N for the selected decal: a small field in place of the button.
  editCount(): void {
    const current = this.editor.decals.selectedSymmetry();
    if (current === null) {
      return;
    }
    this.symmetryButton.style.display = 'none';
    this.countInput.style.display = '';
    this.countInput.value = String(current.count);
    this.countInput.focus();
    this.countInput.select();
  }

  private closeCount(): void {
    this.countInput.style.display = 'none';
    this.symmetryButton.style.display = '';
  }

  // Opening a project replaces what is there: with unsaved work, the Open
  // button asks first ("Discard all?") and a second click (or Ctrl+O, or
  // the same file dropped again) goes ahead.
  askThenOpen(open: () => void): void {
    const button = this.openButton;
    if (!this.actions.unsavedWork()) {
      open();
      return;
    }
    if (button.classList.contains('armed') && this.pendingOpen !== null) {
      window.clearTimeout(this.openArmedTimer);
      button.classList.remove('armed');
      button.textContent = 'Open';
      this.pendingOpen = null;
      open();
      return;
    }
    this.pendingOpen = open;
    button.classList.add('armed');
    button.textContent = 'Discard all?';
    // Clicking the armed button runs what was asked for (a dropped file
    // included), not a fresh file picker.
    const self = this;
    this.openArmedTimer = window.setTimeout(function disarm() {
      button.classList.remove('armed');
      button.textContent = 'Open';
      self.pendingOpen = null;
    }, 4000);
  }

  // New: at once when there is nothing to lose; with work, the first
  // click asks (the button says so for a few seconds) and a second one
  // clears. New cannot be undone.
  private newClicked(): void {
    const editor = this.editor;
    const work = editor.partOrder.length > 0 || editor.decals.artworkOrder.length > 0 || editor.document.placed.length > 0;
    const button = this.newButton;
    if (!work || button.classList.contains('armed')) {
      window.clearTimeout(this.newArmedTimer);
      button.classList.remove('armed');
      button.textContent = 'New';
      this.actions.newProject();
      return;
    }
    button.classList.add('armed');
    button.textContent = 'Discard all?';
    this.newArmedTimer = window.setTimeout(function disarm() {
      button.classList.remove('armed');
      button.textContent = 'New';
    }, 3000);
  }

  // After a part was replaced: the decals to check, each a link that
  // selects it; or, when all landed where they were, a short toast.
  showReplaceReport(oldName: string, newName: string, report: ReattachReport[]): void {
    const editor = this.editor;
    const title = oldName === newName ? oldName + ' replaced.' : oldName + ' replaced by ' + newName + '.';
    if (report.length === 0) {
      this.showError(title + ' Every decal on it stayed in place.');
      return;
    }
    // Linked copies that fared the same are one entry, "fin logo ×4".
    const entries: Array<{ first: ReattachReport; count: number }> = [];
    for (let i = 0; i < report.length; i++) {
      let same = null;
      for (let k = 0; k < entries.length; k++) {
        const other = entries[k].first;
        if (other.name === report[i].name && other.foundNear === report[i].foundNear && Math.abs(other.distance - report[i].distance) < 0.05) {
          same = entries[k];
        }
      }
      if (same === null) {
        entries.push({ first: report[i], count: 1 });
      } else {
        same.count = same.count + 1;
      }
    }
    this.noticeText.textContent = '';
    const intro = element('span', '', this.noticeText);
    intro.textContent = title + ' Check: ';
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i].first;
      if (i > 0) {
        const comma = element('span', '', this.noticeText);
        comma.textContent = '; ';
      }
      const link = element('button', 'notice-link', this.noticeText);
      link.textContent = entries[i].count > 1 ? entry.name + ' ×' + String(entries[i].count) : entry.name;
      link.dataset.decalId = entry.decalId;
      link.addEventListener('click', function selectDecal() {
        editor.decals.select(entry.decalId);
        editor.notify();
      });
      const detail = element('span', 'notice-detail', this.noticeText);
      if (!Number.isFinite(entry.distance)) {
        detail.textContent = ' no surface found';
      } else if (entry.foundNear) {
        detail.textContent = ' moved ' + entry.distance.toFixed(1) + ' mm';
      } else {
        detail.textContent = ' nothing within 10 mm, now ' + entry.distance.toFixed(1) + ' mm away';
      }
    }
    this.notice.style.display = '';
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
      // Preview base colour of the part (paint or bare material).
      const colour = doc.partColours[placed.id];
      const swatch = element('button', 'swatch part-swatch', row);
      swatch.title = 'Preview colour';
      if (colour === undefined) {
        swatch.classList.add('default');
      } else {
        swatch.style.background = colour;
      }
      const popover = this.popover;
      swatch.addEventListener('click', function pickColour(event) {
        event.stopPropagation();
        popover.open(swatch, partColourChoices(doc), colour === undefined ? null : colour, function chosen(picked) {
          editor.decals.setPartColour(placed.id, picked);
        });
      });
      const replace = element('button', 'row-button hover-only', row);
      replace.innerHTML = icon('replace');
      replace.title = 'Replace… with a revised STEP file';
      replace.dataset.action = 'replace-part';
      const self = this;
      replace.addEventListener('click', function replacePart(event) {
        event.stopPropagation();
        self.replacePartTarget = placed.id;
        self.stepInput.click();
      });
      const remove = element('button', 'row-button remove', row);
      remove.innerHTML = icon('trash');
      remove.title = 'Delete (Del)';
      remove.addEventListener('click', function deletePart(event) {
        event.stopPropagation();
        editor.select(placed.id);
        editor.deleteSelected();
      });
      const eye = element('button', 'row-button eye', row);
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

  // Blender's "Adjust Last Operation": after a move or rotate with a gizmo,
  // a small panel shows what that operation did, in the rocket's terms.
  // Typing a value re-does the operation with exactly that value.
  private refreshAdjust(): void {
    const operation = this.editor.lastOperation;
    if (operation === null) {
      this.adjust.style.display = 'none';
      this.adjustFor = null;
      return;
    }
    this.adjust.style.display = '';
    if (this.adjustFor !== operation) {
      this.buildAdjust(operation);
      this.adjustFor = operation;
    }
    const values = operationValues(operation);
    for (let i = 0; i < this.adjustInputs.length; i++) {
      if (document.activeElement !== this.adjustInputs[i]) {
        this.adjustInputs[i].value = values[i].toFixed(1);
      }
    }
  }

  private buildAdjust(operation: LastOperation): void {
    const self = this;
    this.adjust.textContent = '';
    this.adjustInputs.length = 0;
    const title = element('div', 'adjust-title', this.adjust);
    let rows: Array<[string, string]>;
    if (operation.kind === 'move') {
      title.textContent = 'Move';
      rows = [
        ['Along', 'mm'],
        ['Up', 'mm'],
        ['Side', 'mm'],
      ];
    } else if (operation.kind === 'rotate') {
      title.textContent = 'Rotate about';
      // The axis can be changed afterwards, as in Blender.
      const axes = element('div', 'segmented', this.adjust);
      const names: Array<'along' | 'up' | 'side'> = ['along', 'up', 'side'];
      for (let i = 0; i < names.length; i++) {
        const axis = names[i];
        const button = element('button', '', axes);
        button.textContent = axisName(axis);
        button.dataset.axis = axis;
        button.classList.toggle('active', operation.axis === axis);
        button.addEventListener('click', function chooseAxis() {
          self.editor.adjustLastOperation([operation.degrees], axis);
          self.adjustFor = null;
          self.refresh();
        });
      }
      rows = [['Angle', '°']];
    } else if (operation.kind === 'decal-move') {
      title.textContent = 'Move';
      rows = [
        ['Along', 'mm'],
        ['Around', 'mm'],
      ];
    } else if (operation.kind === 'decal-rotate') {
      title.textContent = 'Rotate';
      rows = [['Angle', '°']];
    } else {
      title.textContent = 'Scale';
      rows = [
        ['Width', 'mm'],
        ['Height', 'mm'],
      ];
    }
    for (let r = 0; r < rows.length; r++) {
      const row = element('label', 'adjust-row', this.adjust);
      const label = element('span', 'adjust-label', row);
      label.textContent = rows[r][0];
      const input = element('input', '', row);
      input.type = 'text';
      input.inputMode = 'decimal';
      input.spellcheck = false;
      input.dataset.field = rows[r][0].toLowerCase();
      input.addEventListener('focus', function selectAll() {
        input.select();
      });
      input.addEventListener('change', function apply() {
        self.applyAdjust();
      });
      input.addEventListener('keydown', function keys(event) {
        if (event.key === 'Enter') {
          input.blur();
        } else if (event.key === 'Escape') {
          self.adjustFor = null;
          input.blur();
          self.refresh();
        }
      });
      const unit = element('span', 'unit', row);
      unit.textContent = rows[r][1];
      this.adjustInputs.push(input);
    }
  }

  private applyAdjust(): void {
    const operation = this.editor.lastOperation;
    if (operation === null) {
      return;
    }
    const current = operationValues(operation);
    const values: number[] = [];
    for (let i = 0; i < this.adjustInputs.length; i++) {
      const text = this.adjustInputs[i].value.replace(',', '.').replace('\u2212', '-').trim();
      const value = Number(text);
      if (text === '' || !Number.isFinite(value)) {
        // Not a number: keep what the operation did.
        values.push(current[i]);
        this.adjustInputs[i].value = current[i].toFixed(1);
      } else {
        values.push(value);
      }
    }
    if (operation.kind === 'decal-scale') {
      // Width and height are linked: the one typed sets the other.
      const ratio = operation.start.height / operation.start.width;
      if (Math.abs(values[0] - current[0]) > 1e-9) {
        values[1] = values[0] * ratio;
      } else if (Math.abs(values[1] - current[1]) > 1e-9) {
        values[0] = values[1] / ratio;
      }
    }
    this.editor.adjustLastOperation(values);
  }
}

function operationValues(operation: LastOperation): number[] {
  if (operation.kind === 'move') {
    return [operation.along, operation.up, operation.side];
  }
  if (operation.kind === 'decal-move') {
    return [operation.along, operation.around];
  }
  if (operation.kind === 'decal-scale') {
    return [operation.width, operation.height];
  }
  return [operation.degrees];
}

// Preview colours for a part: the plain grey, white, the vinyl colours.
function partColourChoices(doc: AssemblyDocument): ColourChoice[] {
  const choices: ColourChoice[] = [{ colour: null, title: 'Plain' }, { colour: '#f2f2f2', title: 'White' }];
  for (let i = 0; i < presetVinyl.length; i++) {
    choices.push({ colour: presetVinyl[i].colour, title: presetVinyl[i].name });
  }
  for (let i = 0; i < doc.vinylColours.length; i++) {
    choices.push({ colour: doc.vinylColours[i], title: doc.vinylColours[i] });
  }
  return choices;
}

// A thumbnail of artwork on the part grey, so black and cerise both show.
function artworkThumbnail(artwork: Artwork): string {
  const size = 132;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('artworkThumbnail: no 2D canvas context');
  }
  context.fillStyle = '#9b9ba0';
  context.fillRect(0, 0, size, size);
  const inner = size - 20;
  const scale = inner / Math.max(artwork.width, artwork.height);
  context.translate((size - artwork.width * scale) / 2, (size - artwork.height * scale) / 2);
  drawArtwork(context, artwork, {}, scale);
  return canvas.toDataURL('image/png');
}

function axisName(axis: 'along' | 'up' | 'side'): string {
  if (axis === 'along') {
    return 'Axis';
  }
  if (axis === 'up') {
    return 'Up';
  }
  return 'Side';
}

// A remembered yes/no for this viewer (browser storage may be blocked).
function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Not remembered; it still works for now.
  }
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
