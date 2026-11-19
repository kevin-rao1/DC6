// Reading part names and the length unit straight from the STEP text.
//
// Why: the OpenCascade build we use (replicad-opencascadejs) has
// STEPControl_Reader, which gives the geometry, but not STEPCAFControl_Reader,
// which would give names. So names are read here from the PRODUCT and
// NEXT_ASSEMBLY_USAGE_OCCURRENCE entities, and matched to the solids that
// OpenCascade returns by their order (see solidOwners below).
//
// This is a small reader for the parts of ISO 10303-21 we need, not a full
// STEP parser.

// A parsed parameter: a string, a number, an entity reference, an enumeration,
// a list, a typed value like LENGTH_MEASURE(1.0), or unset ($ or *).
export type StepValue =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'ref'; value: number }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; value: StepValue[] }
  | { kind: 'typed'; type: string; value: StepValue[] }
  | { kind: 'unset' };

// A simple entity has one type; a complex entity "( A() B() )" has several.
export interface StepEntity {
  id: number;
  records: Array<{ type: string; params: StepValue[] }>;
}

// Split the DATA section into "#id = ...;" statements. Semicolons inside
// strings do not end a statement.
function splitStatements(text: string): string[] {
  const statements: string[] = [];
  const dataStart = text.indexOf('DATA;');
  let i = 0;
  if (dataStart >= 0) {
    i = dataStart + 5;
  }
  // Text is copied out by slicing from statementStart, not character by character.
  let statementStart = i;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      if (ch === "'") {
        // A doubled quote is an escaped quote, not the end of the string.
        if (text[i + 1] === "'") {
          i = i + 1;
        } else {
          inString = false;
        }
      }
    } else if (ch === "'") {
      inString = true;
    } else if (ch === ';') {
      const statement = text.slice(statementStart, i).trim();
      statements.push(statement);
      statementStart = i + 1;
    }
    i = i + 1;
  }
  // Doubt: comments (/* ... */) are not removed. Exporters rarely write them
  // inside the DATA section, and one would only spoil the entity it sits in.
  return statements;
}

// Decode the STEP string escapes we are likely to meet in names:
// '' for a quote, \X2\hhhh...\X0\ for UTF-16, \X\hh for one Latin-1 byte, \S\c.
export function decodeStepString(raw: string): string {
  let result = '';
  let i = 0;
  while (i < raw.length) {
    if (raw.startsWith('\\X2\\', i)) {
      const end = raw.indexOf('\\X0\\', i + 4);
      if (end < 0) {
        result = result + raw.slice(i);
        break;
      }
      const hex = raw.slice(i + 4, end);
      for (let k = 0; k + 4 <= hex.length; k = k + 4) {
        const code = parseInt(hex.slice(k, k + 4), 16);
        result = result + String.fromCharCode(code);
      }
      i = end + 4;
    } else if (raw.startsWith('\\X\\', i)) {
      const code = parseInt(raw.slice(i + 3, i + 5), 16);
      result = result + String.fromCharCode(code);
      i = i + 5;
    } else if (raw.startsWith('\\S\\', i)) {
      const code = raw.charCodeAt(i + 3) + 128;
      result = result + String.fromCharCode(code);
      i = i + 4;
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

// A small recursive-descent parser for one parameter list.
class ParamParser {
  text: string;
  pos: number;

  constructor(text: string) {
    this.text = text;
    this.pos = 0;
  }

  skipSpace(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
        this.pos = this.pos + 1;
      } else {
        break;
      }
    }
  }

  // Parse "( a, b, c )" starting at an opening bracket.
  parseList(): StepValue[] {
    const values: StepValue[] = [];
    this.skipSpace();
    if (this.text[this.pos] !== '(') {
      throw new Error('STEP parse: expected ( at ' + this.pos);
    }
    this.pos = this.pos + 1;
    this.skipSpace();
    if (this.text[this.pos] === ')') {
      this.pos = this.pos + 1;
      return values;
    }
    while (this.pos < this.text.length) {
      const value = this.parseValue();
      values.push(value);
      this.skipSpace();
      const ch = this.text[this.pos];
      this.pos = this.pos + 1;
      if (ch === ')') {
        return values;
      }
      if (ch !== ',') {
        throw new Error('STEP parse: expected , or ) at ' + (this.pos - 1));
      }
    }
    throw new Error('STEP parse: unterminated list');
  }

  parseValue(): StepValue {
    this.skipSpace();
    const ch = this.text[this.pos];
    if (ch === "'") {
      let end = this.pos + 1;
      while (end < this.text.length) {
        if (this.text[end] === "'") {
          if (this.text[end + 1] === "'") {
            end = end + 2;
            continue;
          }
          break;
        }
        end = end + 1;
      }
      const raw = this.text.slice(this.pos + 1, end);
      this.pos = end + 1;
      return { kind: 'string', value: decodeStepString(raw) };
    }
    if (ch === '#') {
      let end = this.pos + 1;
      while (end < this.text.length && this.text[end] >= '0' && this.text[end] <= '9') {
        end = end + 1;
      }
      const id = parseInt(this.text.slice(this.pos + 1, end), 10);
      this.pos = end;
      return { kind: 'ref', value: id };
    }
    if (ch === '$' || ch === '*') {
      this.pos = this.pos + 1;
      return { kind: 'unset' };
    }
    if (ch === '.') {
      const end = this.text.indexOf('.', this.pos + 1);
      const name = this.text.slice(this.pos + 1, end);
      this.pos = end + 1;
      return { kind: 'enum', value: name };
    }
    if (ch === '(') {
      const list = this.parseList();
      return { kind: 'list', value: list };
    }
    // A number or a typed value such as LENGTH_MEASURE(1.E-07).
    let end = this.pos;
    while (end < this.text.length) {
      const c = this.text[end];
      if (c === ',' || c === ')' || c === '(' || c === ' ' || c === '\n' || c === '\r') {
        break;
      }
      end = end + 1;
    }
    const word = this.text.slice(this.pos, end);
    this.pos = end;
    this.skipSpace();
    if (this.text[this.pos] === '(') {
      const inner = this.parseList();
      return { kind: 'typed', type: word, value: inner };
    }
    const number = Number(word);
    return { kind: 'number', value: number };
  }

  // Parse the right-hand side of "#id = ...": either TYPE(params) or
  // a complex entity ( TYPE1(params) TYPE2(params) ... ).
  parseRecords(): Array<{ type: string; params: StepValue[] }> {
    const records: Array<{ type: string; params: StepValue[] }> = [];
    this.skipSpace();
    if (this.text[this.pos] === '(') {
      this.pos = this.pos + 1;
      while (this.pos < this.text.length) {
        this.skipSpace();
        if (this.text[this.pos] === ')') {
          break;
        }
        const record = this.parseOneRecord();
        records.push(record);
      }
      return records;
    }
    const record = this.parseOneRecord();
    records.push(record);
    return records;
  }

  parseOneRecord(): { type: string; params: StepValue[] } {
    this.skipSpace();
    let end = this.pos;
    while (end < this.text.length && this.text[end] !== '(' && this.text[end] !== ' ') {
      end = end + 1;
    }
    const type = this.text.slice(this.pos, end).toUpperCase();
    this.pos = end;
    const params = this.parseList();
    return { type: type, params: params };
  }
}

// Parse only the entities whose type is in `wanted` (cheap pre-filter on the
// text, since a rocket file has tens of thousands of geometry entities we do
// not need here). Complex entities are always parsed.
export function parseStepEntities(text: string, wanted: Set<string>): Map<number, StepEntity> {
  const entities = new Map<number, StepEntity>();
  const statements = splitStatements(text);
  for (let s = 0; s < statements.length; s++) {
    const statement = statements[s];
    if (!statement.startsWith('#')) {
      continue;
    }
    const equals = statement.indexOf('=');
    if (equals < 0) {
      continue;
    }
    const id = parseInt(statement.slice(1, equals), 10);
    const rhs = statement.slice(equals + 1).trim();
    const isComplex = rhs.startsWith('(');
    if (!isComplex) {
      const bracket = rhs.indexOf('(');
      const rawTypeName = rhs.slice(0, bracket);
      const typeName = rawTypeName.trim().toUpperCase();
      if (!wanted.has(typeName)) {
        continue;
      }
    }
    try {
      const parser = new ParamParser(rhs);
      const records = parser.parseRecords();
      entities.set(id, { id: id, records: records });
    } catch (error) {
      // An entity we cannot parse is skipped: names are a convenience, and the
      // geometry comes from OpenCascade, not from here.
      continue;
    }
  }
  return entities;
}

function recordOf(entity: StepEntity | undefined, type: string): StepValue[] | null {
  if (entity === undefined) {
    return null;
  }
  for (let i = 0; i < entity.records.length; i++) {
    if (entity.records[i].type === type) {
      return entity.records[i].params;
    }
  }
  return null;
}

function hasRecord(entity: StepEntity | undefined, type: string): boolean {
  return recordOf(entity, type) !== null;
}

function refAt(params: StepValue[], index: number): number | null {
  const value = params[index];
  if (value !== undefined && value.kind === 'ref') {
    return value.value;
  }
  return null;
}

function stringAt(params: StepValue[], index: number): string | null {
  const value = params[index];
  if (value !== undefined && value.kind === 'string') {
    return value.value;
  }
  return null;
}

function simpleType(entity: StepEntity): string {
  if (entity.records.length === 1) {
    return entity.records[0].type;
  }
  return 'COMPLEX';
}

// ---------------------------------------------------------------------------
// Units.

export interface StepLengthUnit {
  name: string; // e.g. "millimetre", "metre", "inch"
  millimetresPerUnit: number | null; // null if not recognised
}

const siPrefixes: Record<string, number> = {
  EXA: 1e18,
  PETA: 1e15,
  TERA: 1e12,
  GIGA: 1e9,
  MEGA: 1e6,
  KILO: 1e3,
  HECTO: 1e2,
  DECA: 1e1,
  DECI: 1e-1,
  CENTI: 1e-2,
  MILLI: 1e-3,
  MICRO: 1e-6,
  NANO: 1e-9,
};

const siPrefixNames: Record<string, string> = {
  KILO: 'kilometre',
  CENTI: 'centimetre',
  MILLI: 'millimetre',
  MICRO: 'micrometre',
  DECI: 'decimetre',
};

// The length unit of the first geometric context in the file. OpenCascade
// does the actual conversion to millimetres when it reads the file; this is
// only to tell the user what the file said.
export function readLengthUnit(text: string): StepLengthUnit {
  const entities = parseStepEntities(text, new Set<string>());
  const ids = Array.from(entities.keys()).sort(function byNumber(a, b) {
    return a - b;
  });
  for (let i = 0; i < ids.length; i++) {
    const entity = entities.get(ids[i]);
    if (!hasRecord(entity, 'LENGTH_UNIT')) {
      continue;
    }
    const si = recordOf(entity, 'SI_UNIT');
    if (si !== null) {
      let prefixName = '';
      const prefix = si[0];
      if (prefix !== undefined && prefix.kind === 'enum') {
        prefixName = prefix.value;
      }
      let factor = 1000;
      let name = 'metre';
      if (prefixName !== '') {
        const scale = siPrefixes[prefixName];
        if (scale !== undefined) {
          factor = scale * 1000;
        }
        const knownName = siPrefixNames[prefixName];
        if (knownName !== undefined) {
          name = knownName;
        } else {
          name = prefixName.toLowerCase() + 'metre';
        }
      }
      return { name: name, millimetresPerUnit: factor };
    }
    const conversion = recordOf(entity, 'CONVERSION_BASED_UNIT');
    if (conversion !== null) {
      const unitName = stringAt(conversion, 0);
      let lower = 'unknown';
      if (unitName !== null) {
        lower = unitName.toLowerCase();
      }
      let factor: number | null = null;
      if (lower === 'inch') {
        factor = 25.4;
      } else if (lower === 'foot') {
        factor = 304.8;
      }
      return { name: lower, millimetresPerUnit: factor };
    }
  }
  return { name: 'unknown (assumed millimetre)', millimetresPerUnit: null };
}

// ---------------------------------------------------------------------------
// Product structure.

// The name information for one solid, in the order OpenCascade returns solids.
export interface SolidOwner {
  productName: string | null;
  instanceName: string | null;
}

const structureTypes = new Set<string>([
  'PRODUCT',
  'PRODUCT_DEFINITION_FORMATION',
  'PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE',
  'PRODUCT_DEFINITION',
  'PRODUCT_DEFINITION_SHAPE',
  'NEXT_ASSEMBLY_USAGE_OCCURRENCE',
  'SHAPE_DEFINITION_REPRESENTATION',
  'SHAPE_REPRESENTATION',
  'ADVANCED_BREP_SHAPE_REPRESENTATION',
  'MANIFOLD_SURFACE_SHAPE_REPRESENTATION',
  'SHAPE_REPRESENTATION_RELATIONSHIP',
  'MANIFOLD_SOLID_BREP',
  'BREP_WITH_VOIDS',
]);

// Walk the product tree the way OpenCascade's STEPControl_ActorRead does, and
// list one owner per solid, in the order the solids come out of the reader:
// for each root product definition (in entity order), first its sub-assembly
// usages (NEXT_ASSEMBLY_USAGE_OCCURRENCE, in entity order), depth first, then
// the solids of its own shape representation.
//
// Doubt: this order is what OCCT 7.x does for the files we write and for the
// usual exporters, but it is not specified anywhere. The caller checks that the
// number of solids matches and falls back to plain "Solid N" names if not.
export function solidOwners(text: string): SolidOwner[] {
  const entities = parseStepEntities(text, structureTypes);
  const ids = Array.from(entities.keys()).sort(function byNumber(a, b) {
    return a - b;
  });

  // product definition id -> product name
  const productNameOfDefinition = new Map<number, string | null>();
  // product definition id -> usages where it is the parent (relating)
  const childUsages = new Map<number, number[]>();
  // product definition ids that are used as a child somewhere
  const usedAsChild = new Set<number>();
  // product definition id -> shape representation ids
  const representationsOfDefinition = new Map<number, number[]>();
  // shape representation id -> related representation ids (geometry often sits
  // in an ADVANCED_BREP_SHAPE_REPRESENTATION linked by a relationship)
  const relatedRepresentations = new Map<number, number[]>();
  const definitionIds: number[] = [];

  for (let i = 0; i < ids.length; i++) {
    const entity = entities.get(ids[i]);
    if (entity === undefined) {
      continue;
    }
    const type = simpleType(entity);
    const params = entity.records[0].params;
    if (type === 'PRODUCT_DEFINITION') {
      definitionIds.push(entity.id);
      const formationId = refAt(params, 2);
      let productName: string | null = null;
      if (formationId !== null) {
        const formation = entities.get(formationId);
        if (formation !== undefined) {
          const productId = refAt(formation.records[0].params, 2);
          if (productId !== null) {
            const product = entities.get(productId);
            const productParams = recordOf(product, 'PRODUCT');
            if (productParams !== null) {
              // PRODUCT(id, name, description, contexts). Prefer the name, fall back to the id.
              productName = stringAt(productParams, 1);
              if (productName === null || productName === '') {
                productName = stringAt(productParams, 0);
              }
            }
          }
        }
      }
      productNameOfDefinition.set(entity.id, productName);
    } else if (type === 'NEXT_ASSEMBLY_USAGE_OCCURRENCE') {
      const parent = refAt(params, 3);
      const child = refAt(params, 4);
      if (parent !== null && child !== null) {
        let list = childUsages.get(parent);
        if (list === undefined) {
          list = [];
          childUsages.set(parent, list);
        }
        list.push(entity.id);
        usedAsChild.add(child);
      }
    } else if (type === 'SHAPE_DEFINITION_REPRESENTATION') {
      const shapeDefinitionId = refAt(params, 0);
      const representationId = refAt(params, 1);
      if (shapeDefinitionId === null || representationId === null) {
        continue;
      }
      const shapeDefinition = entities.get(shapeDefinitionId);
      const pdsParams = recordOf(shapeDefinition, 'PRODUCT_DEFINITION_SHAPE');
      if (pdsParams === null) {
        continue;
      }
      const definitionId = refAt(pdsParams, 2);
      if (definitionId === null) {
        continue;
      }
      // A PRODUCT_DEFINITION_SHAPE can also point at a usage (NAUO); only
      // shapes attached directly to a product definition matter here.
      const target = entities.get(definitionId);
      if (target === undefined || simpleType(target) !== 'PRODUCT_DEFINITION') {
        continue;
      }
      let list = representationsOfDefinition.get(definitionId);
      if (list === undefined) {
        list = [];
        representationsOfDefinition.set(definitionId, list);
      }
      list.push(representationId);
    } else if (type === 'SHAPE_REPRESENTATION_RELATIONSHIP') {
      // Plain relationship (not the complex one with a transformation, which
      // places assembly components and is handled by the usages).
      const a = refAt(params, 2);
      const b = refAt(params, 3);
      if (a !== null && b !== null) {
        addRelated(relatedRepresentations, a, b);
        addRelated(relatedRepresentations, b, a);
      }
    }
  }

  function countSolidsIn(representationId: number, visited: Set<number>): number {
    if (visited.has(representationId)) {
      return 0;
    }
    visited.add(representationId);
    const representation = entities.get(representationId);
    let count = 0;
    if (representation !== undefined) {
      const params = representation.records[0].params;
      const items = params[1];
      if (items !== undefined && items.kind === 'list') {
        for (let k = 0; k < items.value.length; k++) {
          const item = items.value[k];
          if (item.kind !== 'ref') {
            continue;
          }
          const itemEntity = entities.get(item.value);
          if (itemEntity === undefined) {
            continue;
          }
          const itemType = simpleType(itemEntity);
          if (itemType === 'MANIFOLD_SOLID_BREP' || itemType === 'BREP_WITH_VOIDS') {
            count = count + 1;
          }
        }
      }
    }
    const related = relatedRepresentations.get(representationId);
    if (related !== undefined) {
      for (let k = 0; k < related.length; k++) {
        count = count + countSolidsIn(related[k], visited);
      }
    }
    return count;
  }

  const owners: SolidOwner[] = [];

  function visitDefinition(definitionId: number, instanceName: string | null, depth: number): void {
    if (depth > 64) {
      return; // a cycle in a broken file
    }
    const usages = childUsages.get(definitionId);
    if (usages !== undefined) {
      for (let k = 0; k < usages.length; k++) {
        const usage = entities.get(usages[k]);
        if (usage === undefined) {
          continue;
        }
        const usageParams = usage.records[0].params;
        const childId = refAt(usageParams, 4);
        // NAUO(id, name, description, relating, related, reference designator)
        let usageName = stringAt(usageParams, 1);
        if (usageName === null || usageName === '') {
          usageName = stringAt(usageParams, 0);
        }
        if (childId !== null) {
          visitDefinition(childId, usageName, depth + 1);
        }
      }
    }
    const representations = representationsOfDefinition.get(definitionId);
    if (representations !== undefined) {
      const visited = new Set<number>();
      for (let k = 0; k < representations.length; k++) {
        const solidCount = countSolidsIn(representations[k], visited);
        let productName = productNameOfDefinition.get(definitionId);
        if (productName === undefined) {
          productName = null;
        }
        for (let n = 0; n < solidCount; n++) {
          owners.push({ productName: productName, instanceName: instanceName });
        }
      }
    }
  }

  for (let i = 0; i < definitionIds.length; i++) {
    const definitionId = definitionIds[i];
    if (usedAsChild.has(definitionId)) {
      continue;
    }
    visitDefinition(definitionId, null, 0);
  }
  return owners;
}

function addRelated(map: Map<number, number[]>, from: number, to: number): void {
  let list = map.get(from);
  if (list === undefined) {
    list = [];
    map.set(from, list);
  }
  list.push(to);
}
