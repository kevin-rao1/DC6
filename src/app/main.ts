// The app shell: layout, file loading, the import worker, and the state that
// ties the 3D view and the parts panel together.

import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/jetbrains-mono/400.css';
import './style.css';

import type { DcModel, PartVisibility, RocketAxis, Vec3 } from '../geometry/types.ts';
import { reanalyse } from '../geometry/model.ts';
import { axisFromUser, flipAxis } from '../geometry/axis.ts';
import { includedTriangles } from '../geometry/topology.ts';
import type { WorkerReply } from './worker-protocol.ts';
import { Viewer } from './viewer.ts';
import type { PresetView } from './viewer.ts';
import { renderPanel } from './parts-panel.ts';
import type { AxisChoice } from './parts-panel.ts';
import { makeSplit } from './split.ts';

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error('index.html is missing #' + id);
  }
  return node;
}

const statusNode = byId('status');
const panelNode = byId('panel');
const loadingNode = byId('loading');
const loadingText = byId('loading-text');
const dropOverlay = byId('drop-overlay');
const fileInput = byId('file-input') as HTMLInputElement;

makeSplit(byId('split'), byId('view-pane'), byId('divider'), byId('page-pane'));
const viewer = new Viewer(byId('viewer'));

// ---------------------------------------------------------------------------
// State.

interface AppState {
  // The model as the worker produced it (automatic classification and axis).
  imported: DcModel | null;
  // The model as shown, after the user's overrides and axis choice.
  current: DcModel | null;
  overrides: PartVisibility[];
  axisChoice: AxisChoice;
  flipped: boolean;
}

const state: AppState = {
  imported: null,
  current: null,
  overrides: [],
  axisChoice: 'auto',
  flipped: false,
};

function setStatus(text: string): void {
  statusNode.textContent = text;
}

function showLoading(text: string): void {
  loadingText.textContent = text;
  loadingNode.hidden = false;
}

function hideLoading(): void {
  loadingNode.hidden = true;
}

const choiceDirections: Record<string, Vec3> = {
  '+X': [1, 0, 0],
  '-X': [-1, 0, 0],
  '+Y': [0, 1, 0],
  '-Y': [0, -1, 0],
  '+Z': [0, 0, 1],
  '-Z': [0, 0, -1],
};

// The axis implied by the user's choice: the detected one, or a world axis.
function chosenAxis(model: DcModel): RocketAxis {
  let axis = model.axis;
  if (state.axisChoice !== 'auto') {
    const direction = choiceDirections[state.axisChoice];
    const included = includedTriangles(model.mesh, model.faces, state.overrides);
    axis = axisFromUser(model.mesh, model.faces, included, direction);
  }
  if (state.flipped) {
    axis = flipAxis(axis);
  }
  return axis;
}

// Recompute what depends on overrides and axis, and redraw.
function refresh(frameView: boolean): void {
  const imported = state.imported;
  if (imported === null) {
    return;
  }
  const axis = chosenAxis(imported);
  const model = reanalyse(imported, state.overrides, axis);
  state.current = model;
  viewer.setModel(model, model.topology.included, frameView);
  renderPanel(panelNode, model, state.overrides, state.axisChoice, {
    onOverride: function onOverride(partId: number, mode: PartVisibility): void {
      state.overrides[partId] = mode;
      refresh(false);
    },
    onAxisChoice: function onAxisChoice(choice: AxisChoice): void {
      state.axisChoice = choice;
      state.flipped = false;
      refresh(true);
    },
    onFlip: function onFlip(): void {
      state.flipped = !state.flipped;
      refresh(true);
    },
    onHoverPart: function onHoverPart(partId: number): void {
      viewer.highlightPart(partId);
    },
  });
  exposeForTests(model);
}

// A small read-only summary on window, for automated checks (the smoke
// script reads it). Not used by the app itself.
function exposeForTests(model: DcModel): void {
  const instanceSummary: string[] = [];
  for (let i = 0; i < model.instanceSets.length; i++) {
    const set = model.instanceSets[i];
    instanceSummary.push(String(set.members.length) + ' instances of ' + set.name);
  }
  const shownParts: string[] = [];
  const hiddenParts: string[] = [];
  for (let p = 0; p < model.parts.length; p++) {
    const mode = state.overrides[p];
    let shown = model.parts[p].exterior;
    if (mode === 'show') {
      shown = true;
    } else if (mode === 'hide') {
      shown = false;
    }
    if (shown) {
      shownParts.push(model.parts[p].name);
    } else {
      hiddenParts.push(model.parts[p].name);
    }
  }
  const summary = {
    fileName: model.fileName,
    axis: model.axis,
    instances: instanceSummary,
    shownParts: shownParts,
    hiddenParts: hiddenParts,
    timings: model.timings,
    triangles: model.mesh.triangleFace.length,
  };
  (window as unknown as { dc6: unknown }).dc6 = summary;
}

// ---------------------------------------------------------------------------
// The import worker.

const worker = new Worker(new URL('./import-worker.ts', import.meta.url), { type: 'module' });
let busy = false;

worker.onmessage = function onMessage(event: MessageEvent<WorkerReply>): void {
  const message = event.data;
  if (message.type === 'status') {
    if (message.text === 'Ready') {
      if (!busy) {
        setStatus('Ready');
        hideLoading();
        if (document.body.dataset.state === 'starting') {
          document.body.dataset.state = 'idle';
        }
      }
      return;
    }
    setStatus(message.text);
    showLoading(message.text);
    return;
  }
  if (message.type === 'error') {
    busy = false;
    hideLoading();
    setStatus('Error: ' + message.message);
    document.body.dataset.state = 'error';
    return;
  }
  // Result.
  busy = false;
  hideLoading();
  const model = message.model;
  state.imported = model;
  state.overrides = [];
  for (let p = 0; p < model.parts.length; p++) {
    state.overrides.push('auto');
  }
  state.axisChoice = 'auto';
  state.flipped = false;
  refresh(true);
  const seconds = (message.workerMs / 1000).toFixed(2);
  setStatus(model.fileName + ' · imported in ' + seconds + ' s');
  document.body.dataset.state = 'ready';
};

function importBytes(fileName: string, bytes: ArrayBuffer): void {
  busy = true;
  document.body.dataset.state = 'importing';
  showLoading('Reading ' + fileName + '…');
  worker.postMessage({ type: 'import', fileName: fileName, bytes: bytes }, [bytes]);
}

async function importFile(file: File): Promise<void> {
  const bytes = await file.arrayBuffer();
  importBytes(file.name, bytes);
}

fileInput.addEventListener('change', function onChange(): void {
  const files = fileInput.files;
  if (files !== null && files.length > 0) {
    importFile(files[0]);
  }
  fileInput.value = '';
});

// Drag and drop anywhere on the window.
let dragDepth = 0;
window.addEventListener('dragenter', function onEnter(event: DragEvent): void {
  event.preventDefault();
  dragDepth = dragDepth + 1;
  dropOverlay.hidden = false;
});
window.addEventListener('dragleave', function onLeave(event: DragEvent): void {
  event.preventDefault();
  dragDepth = dragDepth - 1;
  if (dragDepth <= 0) {
    dragDepth = 0;
    dropOverlay.hidden = true;
  }
});
window.addEventListener('dragover', function onOver(event: DragEvent): void {
  event.preventDefault();
});
window.addEventListener('drop', function onDrop(event: DragEvent): void {
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const transfer = event.dataTransfer;
  if (transfer === null || transfer.files.length === 0) {
    return;
  }
  importFile(transfer.files[0]);
});

// Preset view buttons and the edges toggle.
const viewButtons = document.querySelectorAll<HTMLButtonElement>('[data-view]');
for (let i = 0; i < viewButtons.length; i++) {
  const button = viewButtons[i];
  button.addEventListener('click', function onClick(): void {
    const view = button.dataset.view as PresetView;
    viewer.setPresetView(view);
  });
}
const edgesToggle = byId('edges-toggle') as HTMLInputElement;
edgesToggle.addEventListener('change', function onChange(): void {
  viewer.setEdgesVisible(edgesToggle.checked);
});

// Developer affordance: ?model=rocket-assembly loads a bundled test model
// (the files in test-models/, served at the site root). Optional
// &view=side|top|nose|tail picks the preset view after loading.
async function loadFromQuery(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const name = params.get('model');
  if (name === null) {
    return;
  }
  // Only plain names: no paths or URLs.
  if (!/^[a-z0-9-]+$/.test(name)) {
    setStatus('Ignored ?model=' + name + ': expected a test model name like rocket-assembly');
    return;
  }
  const url = new URL(name + '.step', window.location.href);
  const response = await fetch(url);
  if (!response.ok) {
    setStatus('Could not load test model ' + name + ' (' + String(response.status) + ')');
    document.body.dataset.state = 'error';
    return;
  }
  const bytes = await response.arrayBuffer();
  importBytes(name + '.step', bytes);
  const view = params.get('view');
  if (view === 'side' || view === 'top' || view === 'nose' || view === 'tail') {
    const wanted: PresetView = view;
    const observer = new MutationObserver(function onChange(): void {
      if (document.body.dataset.state === 'ready') {
        viewer.setPresetView(wanted);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-state'] });
  }
}

loadFromQuery();
