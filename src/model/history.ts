// Undo and redo by snapshots of the whole assembly document. The document is
// small (a few dozen placed parts), so keeping whole copies is simpler and
// safer than recording inverse operations.

import type { AssemblyDocument } from './document.ts';
import { cloneDocument } from './document.ts';

export class History {
  private past: AssemblyDocument[] = [];
  private future: AssemblyDocument[] = [];
  private current: AssemblyDocument;

  constructor(initial: AssemblyDocument) {
    this.current = cloneDocument(initial);
  }

  get document(): AssemblyDocument {
    return this.current;
  }

  // Make `next` the current document, as one undoable step.
  commit(next: AssemblyDocument): void {
    this.past.push(this.current);
    this.current = cloneDocument(next);
    this.future = [];
  }

  // Replace the current document without adding an undo step: used when the
  // user adjusts the last operation (typing an exact value after a drag), so
  // the drag and its adjustment undo together.
  replace(next: AssemblyDocument): void {
    this.current = cloneDocument(next);
    this.future = [];
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  undo(): boolean {
    const previous = this.past.pop();
    if (previous === undefined) {
      return false;
    }
    this.future.push(this.current);
    this.current = previous;
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (next === undefined) {
      return false;
    }
    this.past.push(this.current);
    this.current = next;
    return true;
  }
}
