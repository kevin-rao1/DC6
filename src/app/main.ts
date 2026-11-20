// Start-up: fonts and styles, the editor, the panels, file loading, and the
// test hook.

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

async function openFile(name: string, bytes: ArrayBuffer): Promise<void> {
  const pending = ui.addPending(name);
  try {
    const parts = await importer.importFile(name, bytes);
    for (let i = 0; i < parts.length; i++) {
      editor.addPart(parts[i]);
    }
  } catch (error) {
    let message = String(error);
    if (error instanceof Error) {
      message = error.message;
    }
    ui.showError(name + ': ' + message);
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
    let message = String(error);
    if (error instanceof Error) {
      message = error.message;
    }
    ui.showError(name + ': ' + message);
  }
  editor.notify();
}

function openFiles(files: File[]): void {
  // Where on the rocket the files were dropped, if on the page (read now:
  // the files are read later).
  const droppedAt = pagePane.takeDrop();
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (/\.svg$/i.test(file.name)) {
      file.text().then(function read(text) {
        openSvg(file.name, text, droppedAt);
      });
      continue;
    }
    if (!/\.(step|stp)$/i.test(file.name)) {
      ui.showError(file.name + ' is neither a STEP nor an SVG file.');
      continue;
    }
    file.arrayBuffer().then(function read(bytes) {
      return openFile(file.name, bytes);
    });
  }
}

const ui = new Ui(split.upper, editor, openFiles);

// ?parts=nose,tube,can loads the bundled test parts, in that order.
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

const query = new URLSearchParams(window.location.search);
const partsParameter = query.get('parts');
let bundledLoading: Promise<void> = Promise.resolve();
if (partsParameter !== null && partsParameter !== '') {
  bundledLoading = loadBundledParts(partsParameter.split(','));
}

installTestHook(editor, importer, bundledLoading, pagePane);
