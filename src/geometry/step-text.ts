// Reading the length unit and part names straight from the STEP text.
//
// Why: this OpenCascade build has STEPControl_Reader (geometry) but not
// STEPCAFControl_Reader (names). So names come from the PRODUCT and
// NEXT_ASSEMBLY_USAGE_OCCURRENCE entities and are matched to the solids by
// order. This is a small reader for the few entities we need, not a STEP parser.

// One "#id = TYPE(...)" statement: its id, its type (or "COMPLEX" for a
// "( A() B() )" entity) and the raw parameter text.
interface Statement {
  id: number;
  type: string;
  body: string;
}

function splitStatements(text: string): Statement[] {
  const statements: Statement[] = [];
  const dataStart = text.indexOf('DATA;');
  let i = 0;
  if (dataStart >= 0) {
    i = dataStart + 5;
  }
  let start = i;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      if (ch === "'") {
        inString = false;
      }
    } else if (ch === "'") {
      inString = true;
    } else if (ch === ';') {
      const raw = text.slice(start, i).trim();
      const statement = parseStatement(raw);
      if (statement !== null) {
        statements.push(statement);
      }
      start = i + 1;
    }
    i = i + 1;
  }
  return statements;
}

function parseStatement(raw: string): Statement | null {
  if (!raw.startsWith('#')) {
    return null;
  }
  const equals = raw.indexOf('=');
  if (equals < 0) {
    return null;
  }
  const id = parseInt(raw.slice(1, equals), 10);
  const rhs = raw.slice(equals + 1).trim();
  if (rhs.startsWith('(')) {
    return { id: id, type: 'COMPLEX', body: rhs };
  }
  const bracket = rhs.indexOf('(');
  if (bracket < 0) {
    return null;
  }
  const type = rhs.slice(0, bracket).trim().toUpperCase();
  const body = rhs.slice(bracket);
  return { id: id, type: type, body: body };
}

// The top-level parameters of "(a, b, (c, d), 'e')" as raw strings.
function splitParameters(body: string): string[] {
  const parameters: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (ch === "'") {
        inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
    } else if (ch === '(') {
      depth = depth + 1;
    } else if (ch === ')') {
      depth = depth - 1;
      if (depth === 0) {
        parameters.push(body.slice(start, i).trim());
        break;
      }
    } else if (ch === ',' && depth === 1) {
      parameters.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  return parameters;
}

function refOf(parameter: string | undefined): number | null {
  if (parameter === undefined || !parameter.startsWith('#')) {
    return null;
  }
  return parseInt(parameter.slice(1), 10);
}

function refsIn(parameter: string | undefined): number[] {
  const refs: number[] = [];
  if (parameter === undefined) {
    return refs;
  }
  const pattern = /#(\d+)/g;
  let match = pattern.exec(parameter);
  while (match !== null) {
    refs.push(parseInt(match[1], 10));
    match = pattern.exec(parameter);
  }
  return refs;
}

// Decode a quoted STEP string: '' is a quote, \X2\hhhh\X0\ is UTF-16,
// \X\hh one Latin-1 byte.
export function decodeStepString(parameter: string | undefined): string | null {
  if (parameter === undefined || !parameter.startsWith("'")) {
    return null;
  }
  const raw = parameter.slice(1, parameter.length - 1);
  let result = '';
  let i = 0;
  while (i < raw.length) {
    if (raw.startsWith('\\X2\\', i)) {
      const end = raw.indexOf('\\X0\\', i + 4);
      if (end < 0) {
        break;
      }
      const hex = raw.slice(i + 4, end);
      for (let k = 0; k + 4 <= hex.length; k = k + 4) {
        result = result + String.fromCharCode(parseInt(hex.slice(k, k + 4), 16));
      }
      i = end + 4;
    } else if (raw.startsWith('\\X\\', i)) {
      result = result + String.fromCharCode(parseInt(raw.slice(i + 3, i + 5), 16));
      i = i + 5;
    } else if (raw.startsWith("''", i)) {
      result = result + "'";
      i = i + 2;
    } else {
      result = result + raw[i];
      i = i + 1;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Length unit.

// The name of the file's length unit, e.g. "millimetre" or "inch". Only for
// telling the user; OpenCascade does the conversion to millimetres itself.
export function readLengthUnitName(text: string): string {
  const statements = splitStatements(text);
  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];
    if (statement.type !== 'COMPLEX' || !statement.body.includes('LENGTH_UNIT')) {
      continue;
    }
    const conversion = /CONVERSION_BASED_UNIT\s*\(\s*'([^']*)'/.exec(statement.body);
    if (conversion !== null) {
      return conversion[1].toLowerCase();
    }
    const si = /SI_UNIT\s*\(\s*([.$A-Z]*)\s*,\s*\.METRE\.\s*\)/.exec(statement.body);
    if (si !== null) {
      const prefix = si[1].replace(/\./g, '');
      if (prefix === '' || prefix === '$') {
        return 'metre';
      }
      return prefix.toLowerCase() + 'metre';
    }
  }
  return 'unknown (read as millimetre)';
}

// ---------------------------------------------------------------------------
// Part names.

// The product name of each solid, in the order OpenCascade's
// STEPControl_Reader returns the solids. Walks the product tree the way the
// reader does: for each root product definition (in entity order), first its
// child usages (NEXT_ASSEMBLY_USAGE_OCCURRENCE, in entity order), depth first,
// then the solids of its own shape representation.
//
// Doubt: that order is what OCCT 7.x does for the files we write and the usual
// exporters, but it is not specified anywhere. The caller checks the count
// and falls back to numbered names when it does not match.
export function solidProductNames(text: string): string[] {
  const statements = splitStatements(text);
  const byId = new Map<number, Statement>();
  for (let i = 0; i < statements.length; i++) {
    byId.set(statements[i].id, statements[i]);
  }

  const definitionIds: number[] = [];
  const nameOfDefinition = new Map<number, string>();
  const childUsages = new Map<number, number[]>(); // parent definition -> child definitions
  const usedAsChild = new Set<number>();
  const representationsOfDefinition = new Map<number, number[]>();
  const relatedRepresentations = new Map<number, number[]>();

  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];
    const parameters = splitParameters(statement.body);
    if (statement.type === 'PRODUCT_DEFINITION') {
      definitionIds.push(statement.id);
      // PRODUCT_DEFINITION(id, description, formation, context)
      // -> formation(id, description, product) -> PRODUCT(id, name, ...)
      let name = '';
      const formation = byId.get(refOf(parameters[2]) ?? -1);
      if (formation !== undefined) {
        const product = byId.get(refOf(splitParameters(formation.body)[2]) ?? -1);
        if (product !== undefined && product.type === 'PRODUCT') {
          const productParameters = splitParameters(product.body);
          name = decodeStepString(productParameters[1]) ?? '';
          if (name === '') {
            name = decodeStepString(productParameters[0]) ?? '';
          }
        }
      }
      nameOfDefinition.set(statement.id, name);
    } else if (statement.type === 'NEXT_ASSEMBLY_USAGE_OCCURRENCE') {
      // NAUO(id, name, description, relating (parent), related (child), designator)
      const parent = refOf(parameters[3]);
      const child = refOf(parameters[4]);
      if (parent !== null && child !== null) {
        const list = childUsages.get(parent) ?? [];
        list.push(child);
        childUsages.set(parent, list);
        usedAsChild.add(child);
      }
    } else if (statement.type === 'SHAPE_DEFINITION_REPRESENTATION') {
      // SDR(PRODUCT_DEFINITION_SHAPE, representation); the PDS's third
      // parameter is the product definition (or a usage, which we skip).
      const shapeDefinition = byId.get(refOf(parameters[0]) ?? -1);
      const representation = refOf(parameters[1]);
      if (shapeDefinition === undefined || representation === null || shapeDefinition.type !== 'PRODUCT_DEFINITION_SHAPE') {
        continue;
      }
      const definition = refOf(splitParameters(shapeDefinition.body)[2]);
      if (definition === null) {
        continue;
      }
      const target = byId.get(definition);
      if (target === undefined || target.type !== 'PRODUCT_DEFINITION') {
        continue;
      }
      const list = representationsOfDefinition.get(definition) ?? [];
      list.push(representation);
      representationsOfDefinition.set(definition, list);
    } else if (statement.type === 'SHAPE_REPRESENTATION_RELATIONSHIP') {
      // The plain relationship links a shape representation to the one that
      // holds the geometry. (The complex one with a transformation places
      // assembly components; the usages cover those.)
      const a = refOf(parameters[2]);
      const b = refOf(parameters[3]);
      if (a !== null && b !== null) {
        const listA = relatedRepresentations.get(a) ?? [];
        listA.push(b);
        relatedRepresentations.set(a, listA);
        const listB = relatedRepresentations.get(b) ?? [];
        listB.push(a);
        relatedRepresentations.set(b, listB);
      }
    }
  }

  function countSolids(representationId: number, visited: Set<number>): number {
    if (visited.has(representationId)) {
      return 0;
    }
    visited.add(representationId);
    let count = 0;
    const representation = byId.get(representationId);
    if (representation !== undefined) {
      const items = refsIn(splitParameters(representation.body)[1]);
      for (let k = 0; k < items.length; k++) {
        const item = byId.get(items[k]);
        if (item !== undefined && (item.type === 'MANIFOLD_SOLID_BREP' || item.type === 'BREP_WITH_VOIDS')) {
          count = count + 1;
        }
      }
    }
    const related = relatedRepresentations.get(representationId) ?? [];
    for (let k = 0; k < related.length; k++) {
      count = count + countSolids(related[k], visited);
    }
    return count;
  }

  const names: string[] = [];
  function visit(definitionId: number, depth: number): void {
    if (depth > 64) {
      return; // a cycle in a broken file
    }
    const children = childUsages.get(definitionId) ?? [];
    for (let k = 0; k < children.length; k++) {
      visit(children[k], depth + 1);
    }
    const representations = representationsOfDefinition.get(definitionId) ?? [];
    const visited = new Set<number>();
    for (let k = 0; k < representations.length; k++) {
      const count = countSolids(representations[k], visited);
      for (let n = 0; n < count; n++) {
        names.push(nameOfDefinition.get(definitionId) ?? '');
      }
    }
  }
  for (let i = 0; i < definitionIds.length; i++) {
    if (!usedAsChild.has(definitionIds[i])) {
      visit(definitionIds[i], 0);
    }
  }
  return names;
}
