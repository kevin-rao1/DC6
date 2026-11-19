// The side panel: model summary, axis controls, repeated parts and the parts
// list with the per-part exterior override.

import type { DcModel, PartVisibility } from '../geometry/types.ts';

export type AxisChoice = 'auto' | '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';

export const axisChoices: AxisChoice[] = ['auto', '+X', '-X', '+Y', '-Y', '+Z', '-Z'];

export interface PanelCallbacks {
  onOverride: (partId: number, mode: PartVisibility) => void;
  onAxisChoice: (choice: AxisChoice) => void;
  onFlip: () => void;
  onHoverPart: (partId: number) => void;
}

function element(tag: string, className: string, text: string | null): HTMLElement {
  const node = document.createElement(tag);
  if (className !== '') {
    node.className = className;
  }
  if (text !== null) {
    node.textContent = text;
  }
  return node;
}

function formatNumber(value: number, digits: number): string {
  return value.toFixed(digits);
}

function formatVector(v: [number, number, number]): string {
  const parts: string[] = [];
  for (let i = 0; i < 3; i++) {
    let text = formatNumber(v[i], 5);
    if (text === '-0.00000') {
      text = '0.00000';
    }
    parts.push(text);
  }
  return '(' + parts.join(', ') + ')';
}

// A label/value row; the value is set in the monospace face (numbers).
function row(label: string, value: string, testId: string): HTMLElement {
  const container = element('div', 'row', null);
  container.appendChild(element('span', 'row-label', label));
  const valueNode = element('span', 'row-value mono', value);
  if (testId !== '') {
    valueNode.dataset.testid = testId;
  }
  container.appendChild(valueNode);
  return container;
}

export function renderPanel(
  root: HTMLElement,
  model: DcModel,
  overrides: PartVisibility[],
  axisChoice: AxisChoice,
  callbacks: PanelCallbacks,
): void {
  root.textContent = '';

  // --- Model summary.
  const summary = element('section', 'panel-section', null);
  summary.appendChild(element('h2', '', 'Model'));
  summary.appendChild(row('File', model.fileName, 'file-name'));
  summary.appendChild(row('File unit', model.sourceUnit + ' → mm', 'source-unit'));
  summary.appendChild(row('Parts', String(model.parts.length), 'part-count'));
  summary.appendChild(row('Faces', String(model.faces.length), 'face-count'));
  summary.appendChild(row('Triangles', String(model.mesh.triangleFace.length), 'triangle-count'));
  summary.appendChild(row('Length', formatNumber(model.axis.stationMax - model.axis.stationMin, 1) + ' mm', 'rocket-length'));
  summary.appendChild(row('Import', formatNumber(model.timings.totalMs / 1000, 2) + ' s', 'import-time'));
  root.appendChild(summary);

  // --- Axis.
  const axisSection = element('section', 'panel-section', null);
  axisSection.appendChild(element('h2', '', 'Axis'));
  const directionRow = row('Direction, tail → nose', formatVector(model.axis.direction), 'axis-direction');
  directionRow.className = 'row-block';
  axisSection.appendChild(directionRow);
  axisSection.appendChild(row('Found by', model.axis.source, 'axis-source'));
  axisSection.appendChild(row('Nose end', model.axis.noseConfidence, 'nose-confidence'));
  const axisControls = element('div', 'axis-controls', null);
  const select = document.createElement('select');
  select.dataset.testid = 'axis-select';
  select.title = 'Rocket axis (tail to nose)';
  for (let i = 0; i < axisChoices.length; i++) {
    const option = document.createElement('option');
    option.value = axisChoices[i];
    if (axisChoices[i] === 'auto') {
      option.textContent = 'Detected';
    } else {
      option.textContent = 'Along ' + axisChoices[i];
    }
    if (axisChoices[i] === axisChoice) {
      option.selected = true;
    }
    select.appendChild(option);
  }
  select.addEventListener('change', function onChange(): void {
    callbacks.onAxisChoice(select.value as AxisChoice);
  });
  axisControls.appendChild(select);
  const flip = element('button', 'button', 'Flip nose / tail') as HTMLButtonElement;
  flip.dataset.testid = 'flip-axis';
  flip.addEventListener('click', function onClick(): void {
    callbacks.onFlip();
  });
  axisControls.appendChild(flip);
  axisSection.appendChild(axisControls);
  root.appendChild(axisSection);

  // --- Repeated parts.
  const instances = element('section', 'panel-section', null);
  instances.appendChild(element('h2', '', 'Repeated parts'));
  const instanceList = element('ul', 'instance-list', null);
  instanceList.dataset.testid = 'instance-summary';
  if (model.instanceSets.length === 0) {
    instanceList.appendChild(element('li', 'muted', 'None found'));
  }
  for (let i = 0; i < model.instanceSets.length; i++) {
    const set = model.instanceSets[i];
    const item = element('li', '', null);
    const title = element('div', 'instance-title', null);
    title.appendChild(element('span', 'mono accent', String(set.members.length)));
    title.appendChild(document.createTextNode(' instances of ' + set.name));
    item.appendChild(title);
    const angles: string[] = [];
    for (let k = 0; k < set.members.length; k++) {
      let angle = formatNumber(set.members[k].rollDegrees, 1);
      if (angle === '-0.0') {
        angle = '0.0';
      }
      angles.push(angle + '°');
    }
    let spacing = 'even spacing';
    if (!set.evenlySpaced) {
      spacing = 'uneven spacing';
    }
    item.appendChild(element('div', 'instance-detail mono', 'roll ' + angles.join('  ') + ' · ' + spacing));
    instanceList.appendChild(item);
  }
  instances.appendChild(instanceList);
  root.appendChild(instances);

  // --- Parts.
  const partsSection = element('section', 'panel-section parts-section', null);
  partsSection.appendChild(element('h2', '', 'Parts'));
  const list = element('ul', 'part-list', null);
  list.dataset.testid = 'part-list';
  for (let p = 0; p < model.parts.length; p++) {
    const part = model.parts[p];
    const item = element('li', 'part-row', null);
    item.dataset.partId = String(p);
    item.dataset.exterior = String(part.exterior);
    const mode = overrides[p];
    let shown = part.exterior;
    if (mode === 'show') {
      shown = true;
    } else if (mode === 'hide') {
      shown = false;
    }
    if (!shown) {
      item.classList.add('part-hidden');
    }
    const name = element('div', 'part-name', part.name);
    name.title = part.name;
    item.appendChild(name);
    let autoLabel = 'hidden';
    if (part.exterior) {
      autoLabel = 'exterior';
    }
    const detail = element('div', 'part-detail', null);
    detail.appendChild(element('span', 'mono', formatNumber(100 * part.exteriorAreaFraction, 0) + '% seen'));
    detail.appendChild(document.createTextNode(' · auto: ' + autoLabel));
    item.appendChild(detail);
    const toggle = element('div', 'segmented', null);
    const modes: PartVisibility[] = ['auto', 'show', 'hide'];
    for (let m = 0; m < modes.length; m++) {
      const button = element('button', 'segment', modes[m]) as HTMLButtonElement;
      if (modes[m] === mode) {
        button.classList.add('selected');
      }
      const chosen = modes[m];
      button.addEventListener('click', function onClick(): void {
        callbacks.onOverride(p, chosen);
      });
      toggle.appendChild(button);
    }
    item.appendChild(toggle);
    item.addEventListener('mouseenter', function onEnter(): void {
      callbacks.onHoverPart(p);
    });
    item.addEventListener('mouseleave', function onLeave(): void {
      callbacks.onHoverPart(-1);
    });
    list.appendChild(item);
  }
  partsSection.appendChild(list);
  root.appendChild(partsSection);

  // --- Warnings.
  if (model.warnings.length > 0) {
    const warnings = element('section', 'panel-section', null);
    warnings.appendChild(element('h2', '', 'Notes'));
    for (let i = 0; i < model.warnings.length; i++) {
      warnings.appendChild(element('p', 'warning', model.warnings[i]));
    }
    root.appendChild(warnings);
  }
}
