// The few Playwright types tools/e2e.ts uses. Playwright is installed on the
// test machine, not as a dependency of DC6 (nothing in the app needs it), so
// its own type declarations are not in node_modules. These are written by
// hand from its documentation and cover only what the e2e script calls.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Mouse {
  move(x: number, y: number, options?: { steps?: number }): Promise<void>;
  down(options?: { button?: 'left' | 'right' | 'middle' }): Promise<void>;
  up(options?: { button?: 'left' | 'right' | 'middle' }): Promise<void>;
}

export interface Keyboard {
  press(key: string): Promise<void>;
  type(text: string, options?: { delay?: number }): Promise<void>;
}

export interface Locator {
  first(): Locator;
  boundingBox(): Promise<Box | null>;
  textContent(): Promise<string | null>;
}

export interface Page {
  goto(url: string): Promise<unknown>;
  screenshot(options: { path: string }): Promise<unknown>;
  waitForTimeout(milliseconds: number): Promise<void>;
  waitForFunction(callback: () => boolean): Promise<unknown>;
  evaluate<R>(callback: () => R | Promise<R>): Promise<R>;
  evaluate<R, A>(callback: (argument: A) => R | Promise<R>, argument: A): Promise<R>;
  locator(selector: string): Locator;
  on(event: 'pageerror', listener: (error: Error) => void): void;
  mouse: Mouse;
  keyboard: Keyboard;
}

export interface Browser {
  newPage(options: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<Page>;
  close(): Promise<void>;
}

export interface Playwright {
  chromium: {
    launch(options: { args: string[] }): Promise<Browser>;
  };
}
