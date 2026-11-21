// Start-up: fonts and styles, the editor, the panels, file loading, the
// project file and autosave, and the test hook.

import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/jetbrains-mono/400.css';
import './style.css';

import { Editor } from './editor.ts';
import { Ui } from './ui.ts';
import { Importer } from './importer.ts';
import { installTestHook } from './test-hook.ts';
import { Split } from './split.ts';
import { PagePane } from './page-pane.ts';
import { ProjectFiles } from './project-files.ts';
import { Autosave } from './autosave.ts';
import { downloadBlob } from './downloads.ts';
import { readProject, writeProject } from '../model/project.ts';
import type { ProjectContent } from '../model/project.ts';
import type { SurfacePoint } from '../geometry/geodesic.ts';
import type { Vec3 } from '../geometry/vec3.ts';

const root = document.getElementById('app');
if (root === null) {
  throw new Error('expected an element with id "app"');
}
// The 3D view above, the flat page below (see split.ts).
const split = new Split(root);
const viewport = document.createElement('div');
viewport.className = 'viewport';
split.upper.appendChild(viewport);

const editor = new Editor(viewport);
const pagePane = new PagePane(split.lower, editor);
editor.addListener({
  changed: function showPageOnceBuilt() {
    split.setPageWanted(editor.document.placed.length > 0);
  },
});
const importer = new Importer();
const project = new ProjectFiles(editor, importer);
const autosave = new Autosave();

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function openFile(name: string, bytes: ArrayBuffer): Promise<void> {
  const pending = ui.addPending(name);
  try {
    const imported = await project.importStep(name, new Uint8Array(bytes));
    const parts = imported.parts;
    for (let i = 0; i < parts.length; i++) {
      editor.addPart(parts[i]);
    }
  } catch (error) {
    ui.showError(name + ': ' + messageOf(error));
  } finally {
    ui.removePending(pending);
  }
}

// An SVG file becomes artwork in the decal list; dropped on the page, it
// is also put on the rocket at that point.
function openSvg(name: string, text: string, at: { at: SurfacePoint; right: Vec3 | null } | null): void {
  try {
    const result = editor.decals.addArtwork(text, name);
    ui.showNotice(result.notices);
    if (result.artwork !== null && at !== null) {
      editor.decals.placeArtworkAt(result.artwork.id, at.at, at.right);
    }
  } catch (error) {
    ui.showError(name + ': ' + messageOf(error));
  }
  editor.notify();
}

// ---------------------------------------------------------------------------
// The project file.

// What the work is, to tell whether it has changed since it was saved or
// opened.
let savedFingerprint = '';
function workFingerprint(): string {
  return JSON.stringify([editor.document, editor.partOrder, editor.decals.artworkOrder]);
}

let opening: Promise<void> = Promise.resolve();

async function openContent(content: ProjectContent): Promise<void> {
  pagePane.reset();
  const pendings = new Map<string, ReturnType<Ui['addPending']>>();
  // (Notices about the artwork were given when it was first read.)
  await project.open(content, function progress(name: string, done: boolean) {
    if (!done) {
      pendings.set(name, ui.addPending(name));
      return;
    }
    const entry = pendings.get(name);
    if (entry !== undefined) {
      ui.removePending(entry);
    }
  });
  editor.setView('fit');
}

function openProjectText(name: string, text: string): void {
  opening = (async function run() {
    try {
      const content = await readProject(text);
      await openContent(content);
      savedFingerprint = workFingerprint();
      lastSaved = '';
      scheduleAutosave();
    } catch (error) {
      ui.showError(name + ': ' + messageOf(error));
    }
  })();
}

// The project as a .dc6 file, named after the first part (or "rocket").
async function saveProject(): Promise<void> {
  try {
    const content = await project.content();
    const text = await writeProject(content);
    let name = 'rocket';
    if (editor.partOrder.length > 0) {
      const first = editor.parts.get(editor.partOrder[0]);
      if (first !== undefined) {
        name = first.name;
      }
    }
    downloadBlob(name + '.dc6', new Blob([text], { type: 'application/json' }));
    savedFingerprint = workFingerprint();
  } catch (error) {
    ui.showError('Save: ' + messageOf(error));
  }
}

// New: forget everything, and the autosave.
function newProject(): void {
  editor.clearAll();
  project.clear();
  pagePane.reset();
  lastSaved = '';
  void autosave.clear();
  ui.refresh();
}

function openFiles(files: File[]): void {
  // Where on the rocket the files were dropped, if on the page (read now:
  // the files are read later).
  const droppedAt = pagePane.takeDrop();
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (/\.dc6$/i.test(file.name)) {
      file.text().then(function read(text) {
        ui.askThenOpen(function open() {
          openProjectText(file.name, text);
        });
      });
      continue;
    }
    if (/\.svg$/i.test(file.name)) {
      file.text().then(function read(text) {
        openSvg(file.name, text, droppedAt);
      });
      continue;
    }
    if (!/\.(step|stp)$/i.test(file.name)) {
      ui.showError(file.name + ' is not a STEP, SVG or DC6 project file.');
      continue;
    }
    file.arrayBuffer().then(function read(bytes) {
      return openFile(file.name, bytes);
    });
  }
}

// Replace a placed part's source part by a revised STEP file.
async function replacePart(placedId: string, file: File): Promise<void> {
  const placed = editor.document.placed.find(function byId(p) {
    return p.id === placedId;
  });
  if (placed === undefined) {
    return;
  }
  const oldPart = editor.parts.get(placed.partId);
  if (oldPart === undefined) {
    return;
  }
  const pending = ui.addPending(file.name);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const imported = await project.importStep(file.name, bytes, false);
    const parts = imported.parts;
    if (parts.length === 0) {
      throw new Error('no solid in the file');
    }
    // The same solid of the new file as of the old one, else the first.
    const hash = oldPart.id.lastIndexOf('#');
    let solid = 0;
    if (hash >= 0) {
      const number = parseInt(oldPart.id.slice(hash + 1), 10);
      if (Number.isFinite(number) && number < parts.length) {
        solid = number;
      }
    }
    const newPart = parts[solid];
    const report = editor.replacePart(oldPart.id, newPart);
    project.remember(newPart.id, imported.file, solid);
    ui.showReplaceReport(oldPart.name, newPart.name, report);
  } catch (error) {
    ui.showError(file.name + ': ' + messageOf(error));
  } finally {
    ui.removePending(pending);
  }
}

const ui = new Ui(split.upper, editor, pagePane, {
  openFiles: openFiles,
  save: function save() {
    void saveProject();
  },
  newProject: newProject,
  unsavedWork: function unsavedWork(): boolean {
    const doc = editor.document;
    const work = editor.partOrder.length > 0 || editor.decals.artworkOrder.length > 0 || doc.placed.length > 0;
    return work && workFingerprint() !== savedFingerprint;
  },
  replacePart: function replace(placedId: string, file: File) {
    void replacePart(placedId, file);
  },
});

// ---------------------------------------------------------------------------
// Autosave: a moment after each change, if anything was changed.

let lastSaved = '';
let autosaveTimer = 0;

function scheduleAutosave(): void {
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(function save() {
    void runAutosave();
  }, 800);
}

async function runAutosave(): Promise<void> {
  if (project.loading || startingUp) {
    return;
  }
  const content = await project.content();
  if (content.partOrder.length === 0 && content.artworks.length === 0 && content.document.placed.length === 0) {
    return; // nothing worth keeping (New clears the autosave itself)
  }
  const fingerprint = JSON.stringify([content.document, content.partOrder, content.parts, content.artworkOrder, content.artworks.length]);
  if (fingerprint === lastSaved) {
    return;
  }
  lastSaved = fingerprint;
  await autosave.save(content);
  autosaveCount = autosaveCount + 1;
}

let autosaveCount = 0;
editor.addListener({
  changed: function changed() {
    scheduleAutosave();
  },
});

// ---------------------------------------------------------------------------
// Start: ?parts=nose,tube,can loads those bundled test parts in that order;
// otherwise the autosave, if there is one, is simply restored.

let startingUp = true;

async function loadBundledParts(names: string[]): Promise<void> {
  for (let i = 0; i < names.length; i++) {
    const fileName = names[i] + '.step';
    const response = await fetch('./' + fileName);
    if (!response.ok) {
      ui.showError(fileName + ' is not one of the bundled test parts.');
      continue;
    }
    const bytes = await response.arrayBuffer();
    await openFile(fileName, bytes);
  }
}

async function start(): Promise<void> {
  try {
    const query = new URLSearchParams(window.location.search);
    const partsParameter = query.get('parts');
    if (partsParameter !== null && partsParameter !== '') {
      await loadBundledParts(partsParameter.split(','));
      return;
    }
    const saved = await autosave.load();
    if (saved !== null) {
      await openContent(saved);
    }
  } catch (error) {
    ui.showError('Restoring the last session: ' + messageOf(error));
  } finally {
    startingUp = false;
  }
}

const started = start();

installTestHook(editor, importer, started, pagePane, {
  opening: function whenOpened() {
    return opening;
  },
  autosaves: function count() {
    return autosaveCount;
  },
  flushAutosave: async function flush() {
    window.clearTimeout(autosaveTimer);
    await runAutosave();
  },
});
