// A small XML reader: enough for SVG files as drawing programs write them.
// Elements, attributes, text, comments, CDATA, processing instructions, and
// a DOCTYPE whose internal subset may declare entities (Illustrator writes
// those). No namespaces beyond keeping the prefixed names as written; no
// validation.
//
// Written here rather than using DOMParser so the same code runs in the
// browser, in the import tests under Node, and without a dependency.

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  // Text directly inside this element (all text nodes joined).
  text: string;
}

const predefinedEntities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string, entities: Record<string, string>): string {
  if (text.indexOf('&') < 0) {
    return text;
  }
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z_][\w.-]*);/g, function decode(whole: string, name: string): string {
    if (name[0] === '#') {
      let code = 0;
      if (name[1] === 'x' || name[1] === 'X') {
        code = parseInt(name.slice(2), 16);
      } else {
        code = parseInt(name.slice(1), 10);
      }
      if (!Number.isFinite(code)) {
        return whole;
      }
      return String.fromCodePoint(code);
    }
    const value = entities[name];
    if (value === undefined) {
      return whole;
    }
    return value;
  });
}

export function parseXml(source: string): XmlElement {
  const entities: Record<string, string> = Object.assign({}, predefinedEntities);
  // A synthetic document node holds the root element.
  const documentNode: XmlElement = { name: '#document', attributes: {}, children: [], text: '' };
  const stack: XmlElement[] = [documentNode];
  let index = 0;
  const length = source.length;

  function fail(message: string): never {
    throw new Error('Not a readable SVG file: ' + message + ' (at character ' + String(index) + ')');
  }

  while (index < length) {
    const open = source.indexOf('<', index);
    if (open < 0) {
      appendText(stack[stack.length - 1], source.slice(index), entities);
      break;
    }
    if (open > index) {
      appendText(stack[stack.length - 1], source.slice(index, open), entities);
    }
    index = open;
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      if (end < 0) {
        fail('unclosed comment');
      }
      index = end + 3;
    } else if (source.startsWith('<![CDATA[', index)) {
      const end = source.indexOf(']]>', index + 9);
      if (end < 0) {
        fail('unclosed CDATA section');
      }
      stack[stack.length - 1].text += source.slice(index + 9, end);
      index = end + 3;
    } else if (source.startsWith('<?', index)) {
      const end = source.indexOf('?>', index + 2);
      if (end < 0) {
        fail('unclosed processing instruction');
      }
      index = end + 2;
    } else if (source.startsWith('<!DOCTYPE', index) || source.startsWith('<!doctype', index)) {
      index = readDoctype(source, index, entities);
    } else if (source.startsWith('</', index)) {
      const end = source.indexOf('>', index);
      if (end < 0) {
        fail('unclosed end tag');
      }
      const name = source.slice(index + 2, end).trim();
      const top = stack[stack.length - 1];
      if (stack.length === 1 || top.name !== name) {
        fail('end tag </' + name + '> does not match <' + top.name + '>');
      }
      stack.pop();
      index = end + 1;
    } else {
      const parsed = readStartTag(source, index, entities);
      if (parsed === null) {
        fail('malformed tag');
      }
      const element = parsed.element;
      stack[stack.length - 1].children.push(element);
      if (!parsed.selfClosing) {
        stack.push(element);
      }
      index = parsed.end;
    }
  }
  if (stack.length !== 1) {
    fail('<' + stack[stack.length - 1].name + '> is not closed');
  }
  const roots = documentNode.children;
  if (roots.length !== 1) {
    fail('expected exactly one root element, found ' + String(roots.length));
  }
  return roots[0];
}

function appendText(element: XmlElement, raw: string, entities: Record<string, string>): void {
  element.text += decodeEntities(raw, entities);
}

// Read a start tag at `start` ("<name attr='v' ...>" or ".../>").
function readStartTag(source: string, start: number, entities: Record<string, string>): { element: XmlElement; selfClosing: boolean; end: number } | null {
  let index = start + 1;
  const nameMatch = /^[^\s/>]+/.exec(source.slice(index, index + 256));
  if (nameMatch === null) {
    return null;
  }
  const name = nameMatch[0];
  index = index + name.length;
  const attributes: Record<string, string> = {};
  for (;;) {
    while (index < source.length && /\s/.test(source[index])) {
      index = index + 1;
    }
    if (index >= source.length) {
      return null;
    }
    if (source[index] === '>') {
      return { element: { name: name, attributes: attributes, children: [], text: '' }, selfClosing: false, end: index + 1 };
    }
    if (source.startsWith('/>', index)) {
      return { element: { name: name, attributes: attributes, children: [], text: '' }, selfClosing: true, end: index + 2 };
    }
    const attributeMatch = /^([^\s=/>]+)\s*=\s*/.exec(source.slice(index, index + 512));
    if (attributeMatch === null) {
      return null;
    }
    index = index + attributeMatch[0].length;
    const quote = source[index];
    if (quote !== '"' && quote !== "'") {
      return null;
    }
    const close = source.indexOf(quote, index + 1);
    if (close < 0) {
      return null;
    }
    const raw = source.slice(index + 1, close);
    attributes[attributeMatch[1]] = decodeEntities(raw, entities);
    index = close + 1;
  }
}

// Skip a DOCTYPE, collecting <!ENTITY name "value"> declarations from its
// internal subset. Returns the index after it.
function readDoctype(source: string, start: number, entities: Record<string, string>): number {
  let index = start + 9;
  let depth = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '[') {
      depth = depth + 1;
    } else if (ch === ']') {
      depth = depth - 1;
    } else if (ch === '>' && depth === 0) {
      return index + 1;
    } else if (depth > 0 && source.startsWith('<!ENTITY', index)) {
      const match = /^<!ENTITY\s+([^\s]+)\s+(["'])([\s\S]*?)\2\s*>/.exec(source.slice(index, index + 4096));
      if (match !== null) {
        entities[match[1]] = match[3];
        index = index + match[0].length;
        continue;
      }
    } else if (depth > 0 && source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index);
      if (end >= 0) {
        index = end + 3;
        continue;
      }
    }
    index = index + 1;
  }
  return index;
}
