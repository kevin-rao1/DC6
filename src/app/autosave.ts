// Autosave to the browser's IndexedDB, as a convenience only: the saved
// project file is the real copy (brief v1 4.7). The STEP files are kept by
// hash in their own store, so each is written once however often the
// project is saved. Everything is wrapped in try/catch: with storage
// blocked (a private window, a strict browser) autosave quietly does
// nothing and the app works as before.

import type { ProjectContent, ProjectStepFile } from '../model/project.ts';

const databaseName = 'dc6';
const databaseVersion = 1;
const stateStore = 'state';
const fileStore = 'files';
const stateKey = 'current';

// What is kept: the project without the STEP bytes, which are in the file
// store under their hashes.
export interface SavedState {
  content: Omit<ProjectContent, 'files'>;
  files: Array<{ name: string; hash: string }>;
  savedAt: number;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise<T>(function wait(resolve, reject) {
    r.onsuccess = function done() {
      resolve(r.result);
    };
    r.onerror = function failed() {
      reject(r.error);
    };
  });
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>(function wait(resolve, reject) {
    transaction.oncomplete = function done() {
      resolve();
    };
    transaction.onerror = function failed() {
      reject(transaction.error);
    };
    transaction.onabort = function aborted() {
      reject(transaction.error);
    };
  });
}

export class Autosave {
  private database: Promise<IDBDatabase | null> | null = null;
  // Hashes of the STEP files already in the file store.
  private readonly stored = new Set<string>();

  private open(): Promise<IDBDatabase | null> {
    if (this.database !== null) {
      return this.database;
    }
    this.database = new Promise<IDBDatabase | null>(function openDatabase(resolve) {
      try {
        const opening = indexedDB.open(databaseName, databaseVersion);
        opening.onupgradeneeded = function upgrade() {
          const db = opening.result;
          if (!db.objectStoreNames.contains(stateStore)) {
            db.createObjectStore(stateStore);
          }
          if (!db.objectStoreNames.contains(fileStore)) {
            db.createObjectStore(fileStore);
          }
        };
        opening.onsuccess = function opened() {
          resolve(opening.result);
        };
        opening.onerror = function failed() {
          resolve(null);
        };
        opening.onblocked = function blocked() {
          resolve(null);
        };
      } catch {
        resolve(null);
      }
    });
    return this.database;
  }

  // The last autosave, or null if there is none (or storage is blocked).
  async load(): Promise<ProjectContent | null> {
    try {
      const db = await this.open();
      if (db === null) {
        return null;
      }
      const reading = db.transaction([stateStore, fileStore], 'readonly');
      const state = (await request(reading.objectStore(stateStore).get(stateKey))) as SavedState | undefined;
      if (state === undefined) {
        return null;
      }
      const files: ProjectStepFile[] = [];
      for (let i = 0; i < state.files.length; i++) {
        const bytes = (await request(reading.objectStore(fileStore).get(state.files[i].hash))) as Uint8Array | undefined;
        if (bytes === undefined) {
          return null; // incomplete: better nothing than half a rocket
        }
        files.push({ name: state.files[i].name, bytes: bytes, hash: state.files[i].hash });
        this.stored.add(state.files[i].hash);
      }
      const content: ProjectContent = {
        document: state.content.document,
        partOrder: state.content.partOrder,
        parts: state.content.parts,
        files: files,
        artworks: state.content.artworks,
        artworkOrder: state.content.artworkOrder,
      };
      return content;
    } catch {
      return null;
    }
  }

  async save(content: ProjectContent): Promise<void> {
    try {
      const db = await this.open();
      if (db === null) {
        return;
      }
      const writing = db.transaction([stateStore, fileStore], 'readwrite');
      const files = writing.objectStore(fileStore);
      const wanted = new Set<string>();
      for (let i = 0; i < content.files.length; i++) {
        const file = content.files[i];
        wanted.add(file.hash);
        if (!this.stored.has(file.hash)) {
          files.put(file.bytes, file.hash);
          this.stored.add(file.hash);
        }
      }
      const names: Array<{ name: string; hash: string }> = [];
      for (let i = 0; i < content.files.length; i++) {
        names.push({ name: content.files[i].name, hash: content.files[i].hash });
      }
      const state: SavedState = {
        content: {
          document: content.document,
          partOrder: content.partOrder,
          parts: content.parts,
          artworks: content.artworks,
          artworkOrder: content.artworkOrder,
        },
        files: names,
        savedAt: Date.now(),
      };
      writing.objectStore(stateStore).put(state, stateKey);
      // STEP files no longer used go.
      const keys = await request(files.getAllKeys());
      for (let i = 0; i < keys.length; i++) {
        const key = String(keys[i]);
        if (!wanted.has(key)) {
          files.delete(keys[i]);
          this.stored.delete(key);
        }
      }
      await finished(writing);
    } catch {
      // Storage refused (full, blocked): the project file is the real copy.
    }
  }

  async clear(): Promise<void> {
    try {
      const db = await this.open();
      if (db === null) {
        return;
      }
      const clearing = db.transaction([stateStore, fileStore], 'readwrite');
      clearing.objectStore(stateStore).clear();
      clearing.objectStore(fileStore).clear();
      this.stored.clear();
      await finished(clearing);
    } catch {
      // Nothing to clear, or storage blocked.
    }
  }
}
