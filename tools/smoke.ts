// Browser smoke test: build, serve dist/, load test rockets in Chromium, check
// what the page reports, and take screenshots.
//
// Run with:   npm run smoke [-- --out <folder>] [-- --no-build]
//
// Needs Playwright with Chromium installed on the machine. It is not a
// dependency of DC6 (the app does not use it), so it is loaded with require()
// from wherever it is installed (NODE_PATH or a global install).
//
// Not part of `npm test`: it needs a browser and takes about half a minute.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const distFolder = join(root, 'dist');

function argumentValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) {
    return null;
  }
  return process.argv[index + 1];
}

let outputFolder = argumentValue('--out');
if (outputFolder === null) {
  outputFolder = join(tmpdir(), 'dc6-smoke');
}
await mkdir(outputFolder, { recursive: true });

if (!process.argv.includes('--no-build')) {
  console.log('building…');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
}
if (!existsSync(join(distFolder, 'index.html'))) {
  throw new Error('dist/index.html not found; run npm run build');
}

// A minimal static file server for dist/ (no dependency needed).
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.step': 'application/octet-stream',
};

async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  let path = decodeURIComponent(url.pathname);
  if (path === '/') {
    path = '/index.html';
  }
  const filePath = normalize(join(distFolder, path));
  if (!filePath.startsWith(distFolder)) {
    response.writeHead(403);
    response.end();
    return;
  }
  try {
    const body = await readFile(filePath);
    let type = contentTypes[extname(filePath)];
    if (type === undefined) {
      type = 'application/octet-stream';
    }
    response.writeHead(200, { 'content-type': type });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
}

const server = createServer(function handle(request, response): void {
  serve(request, response);
});
await new Promise<void>(function listen(resolve): void {
  server.listen(0, '127.0.0.1', function listening(): void {
    resolve();
  });
});
const address = server.address();
if (address === null || typeof address === 'string') {
  throw new Error('server did not start');
}
const baseUrl = 'http://127.0.0.1:' + String(address.port) + '/';
console.log('serving dist/ at ' + baseUrl);

const require = createRequire(import.meta.url);
const playwright = require('playwright');
const browser = await playwright.chromium.launch();
// Software WebGL in headless Chromium is fine for a screenshot.
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const pageErrors: string[] = [];
page.on('pageerror', function onError(error: Error): void {
  pageErrors.push(error.message);
});
page.on('console', function onConsole(message: { type(): string; text(): string }): void {
  if (message.type() === 'error') {
    pageErrors.push(message.text());
  }
});
// Any request that leaves 127.0.0.1 is a third-party request (fonts must be bundled).
const thirdParty: string[] = [];
page.on('request', function onRequest(request: { url(): string }): void {
  const requestUrl = request.url();
  if (!requestUrl.startsWith(baseUrl) && !requestUrl.startsWith('data:') && !requestUrl.startsWith('blob:')) {
    thirdParty.push(requestUrl);
  }
});

interface Check {
  model: string;
  view: string;
}

const checks: Check[] = [
  { model: 'rocket-internals', view: 'side' },
  { model: 'rocket-internals', view: 'tail' },
  { model: 'rocket-fused', view: 'side' },
  { model: 'rocket-assembly', view: 'top' },
];

let failures = 0;
for (let i = 0; i < checks.length; i++) {
  const check = checks[i];
  const start = Date.now();
  await page.goto(baseUrl + '?model=' + check.model + '&view=' + check.view);
  await page.waitForFunction(
    function isDone(): boolean {
      const state = document.body.dataset.state;
      return state === 'ready' || state === 'error';
    },
    null,
    { timeout: 120000 },
  );
  const state = await page.evaluate(function readState(): string | undefined {
    return document.body.dataset.state;
  });
  const elapsed = Date.now() - start;
  // Give the renderer a couple of frames after the view change.
  await page.waitForTimeout(500);
  const screenshot = join(outputFolder, check.model + '-' + check.view + '.png');
  await page.screenshot({ path: screenshot });
  // A second picture with the parts panel scrolled to the end of the list.
  await page.evaluate(function scrollPanel(): void {
    const panel = document.getElementById('panel');
    if (panel !== null) {
      panel.scrollTop = panel.scrollHeight;
    }
  });
  const panelScreenshot = join(outputFolder, check.model + '-' + check.view + '-parts.png');
  await page.screenshot({ path: panelScreenshot });
  const summary = await page.evaluate(function readSummary(): unknown {
    return (window as unknown as { dc6: unknown }).dc6;
  });
  const status = await page.textContent('#status');
  console.log('--- ' + check.model + ' (' + String(elapsed) + ' ms in the browser, state ' + String(state) + ')');
  console.log('status: ' + String(status));
  console.log(JSON.stringify(summary, null, 2));
  console.log('screenshots: ' + screenshot + ', ' + panelScreenshot);
  if (state !== 'ready') {
    failures = failures + 1;
  }
}

await browser.close();
server.close();

if (pageErrors.length > 0) {
  console.log('page errors:');
  for (let i = 0; i < pageErrors.length; i++) {
    console.log('  ' + pageErrors[i]);
  }
  failures = failures + 1;
}
if (thirdParty.length > 0) {
  console.log('third-party requests:');
  for (let i = 0; i < thirdParty.length; i++) {
    console.log('  ' + thirdParty[i]);
  }
  failures = failures + 1;
}
if (failures > 0) {
  console.log('SMOKE FAILED');
  process.exit(1);
}
console.log('smoke passed');
