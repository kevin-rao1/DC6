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

const root = document.getElementById('app');
if (root === null) {
  throw new Error('expected an element with id "app"');
}
const viewport = document.createElement('div');
viewport.className = 'viewport';
root.appendChild(viewport);

const editor = new Editor(viewport);
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

// An SVG file becomes artwork in the decal list.
function openSvg(name: string, text: string): void {
  try {
    const result = editor.decals.addArtwork(text, name);
    ui.showNotice(result.notices);
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
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (/\.svg$/i.test(file.name)) {
      file.text().then(function read(text) {
        openSvg(file.name, text);
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

const ui = new Ui(root, editor, openFiles);

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

installTestHook(editor, importer, bundledLoading);
