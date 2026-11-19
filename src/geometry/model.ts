// The import pipeline after OpenCascade: CadImport (per-face triangles) ->
// DcModel (welded mesh, exterior, axis, instances).
//
// Pure TypeScript on plain data, so it runs in the import worker, on the page
// (when the user changes the axis or a part override) and under Node in tests.

import type { CadImport } from './step-import.ts';
import { angularDeflection, linearDeflection } from './tessellation.ts';
import type { CadPart, DcModel, PartVisibility, RocketAxis } from './types.ts';
import { weldFaces } from './mesh.ts';
import { buildBvh } from './bvh.ts';
import { classifyExterior, faceVisibility, orientOutward } from './exterior.ts';
import { buildTopology, includedTriangles } from './topology.ts';
import { classifyAxisymmetric, detectAxis } from './axis.ts';
import { detectInstances } from './instances.ts';

function nowMs(): number {
  return performance.now();
}

// Display names: the product name, or "Solid N" when the file has none.
// A product used several times (a patterned fin) gets "#1", "#2"... in the
// order the solids come out of the file.
function makeParts(cad: CadImport): CadPart[] {
  const useCount = new Map<string, number>();
  for (let i = 0; i < cad.parts.length; i++) {
    const name = cad.parts[i].productName;
    if (name !== null) {
      const previous = useCount.get(name);
      if (previous === undefined) {
        useCount.set(name, 1);
      } else {
        useCount.set(name, previous + 1);
      }
    }
  }
  const seen = new Map<string, number>();
  const parts: CadPart[] = [];
  for (let i = 0; i < cad.parts.length; i++) {
    const productName = cad.parts[i].productName;
    let name = 'Solid ' + String(i + 1);
    if (productName !== null && productName !== '') {
      name = productName;
      const uses = useCount.get(productName);
      if (uses !== undefined && uses > 1) {
        const previous = seen.get(productName);
        let index = 1;
        if (previous !== undefined) {
          index = previous + 1;
        }
        seen.set(productName, index);
        name = productName + ' #' + String(index);
      }
    }
    parts.push({
      id: i,
      name: name,
      productName: productName,
      instanceName: cad.parts[i].instanceName,
      faceIds: [],
      area: 0,
      exteriorAreaFraction: 0,
      exterior: false,
    });
  }
  return parts;
}

export function buildModel(cad: CadImport): DcModel {
  const start = nowMs();

  const welded = weldFaces(cad);
  const mesh = welded.mesh;
  const faces = welded.faces;
  const parts = makeParts(cad);
  for (let f = 0; f < faces.length; f++) {
    parts[faces[f].part].faceIds.push(f);
  }
  const weldEnd = nowMs();

  // Exterior: ray cast against every triangle of the model.
  const bvh = buildBvh(mesh.positions, mesh.triangles, null);
  const visibility = faceVisibility(mesh, faces, bvh);
  classifyExterior(faces, parts, visibility);
  orientOutward(mesh, faces, visibility);
  const included = includedTriangles(mesh, faces, null);
  const topology = buildTopology(mesh, faces, included);
  const exteriorEnd = nowMs();

  const warnings = cad.warnings.slice();
  let shownTriangles = 0;
  for (let t = 0; t < included.length; t++) {
    shownTriangles = shownTriangles + included[t];
  }
  if (shownTriangles === 0) {
    throw new Error('Nothing in this file can be seen from outside; it may be empty or only internal parts.');
  }

  const axis = detectAxis(mesh, faces, included);
  classifyAxisymmetric(mesh, faces, axis);
  const axisEnd = nowMs();

  const instanceSets = detectInstances(mesh, faces, parts, topology, axis);
  const end = nowMs();

  if (topology.nonManifoldEdgeCount > 0) {
    warnings.push(String(topology.nonManifoldEdgeCount) + ' exterior edges are shared by more than two triangles.');
  }
  if (axis.noseConfidence === 'uncertain') {
    warnings.push('Could not tell which end is the nose; check the axis and flip it if needed.');
  }

  return {
    fileName: cad.fileName,
    sourceUnit: cad.sourceUnit,
    parts: parts,
    faces: faces,
    mesh: mesh,
    axis: axis,
    instanceSets: instanceSets,
    topology: topology,
    linearDeflection: linearDeflection,
    angularDeflection: angularDeflection,
    warnings: warnings,
    timings: {
      readMs: cad.readMs,
      meshMs: cad.meshMs,
      weldMs: weldEnd - start,
      exteriorMs: exteriorEnd - weldEnd,
      axisMs: axisEnd - exteriorEnd,
      instancesMs: end - axisEnd,
      totalMs: cad.readMs + cad.meshMs + (end - start),
    },
  };
}

// Recompute what depends on the shown parts and the axis, after the user
// changes a part override or the axis. Returns a new model object sharing the
// mesh and faces (faces' axisymmetric flags are updated in place).
export function reanalyse(model: DcModel, overrides: PartVisibility[], axis: RocketAxis): DcModel {
  const included = includedTriangles(model.mesh, model.faces, overrides);
  const topology = buildTopology(model.mesh, model.faces, included);
  classifyAxisymmetric(model.mesh, model.faces, axis);
  const instanceSets = detectInstances(model.mesh, model.faces, model.parts, topology, axis);
  const result: DcModel = {
    fileName: model.fileName,
    sourceUnit: model.sourceUnit,
    parts: model.parts,
    faces: model.faces,
    mesh: model.mesh,
    axis: axis,
    instanceSets: instanceSets,
    topology: topology,
    linearDeflection: model.linearDeflection,
    angularDeflection: model.angularDeflection,
    warnings: model.warnings,
    timings: model.timings,
  };
  return result;
}
