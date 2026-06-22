import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const BACKEND_BIN = '/Users/halo/Documents/pounding desktop/AionCore/target/debug/poundingcore';
const PORT = 25815;
const BASE = `http://127.0.0.1:${PORT}`;

// Start backend
const tmpDir = mkdtempSync(join(tmpdir(), 'pound-test-'));
console.log(`Starting backend on ${PORT}...`);
const backend = spawn(BACKEND_BIN, ['--port', String(PORT), '--local', '--data-dir', tmpDir], {
  stdio: 'pipe',
});

// Wait for LISTENING
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Backend startup timeout')), 15000);
  backend.stdout.on('data', (data) => {
    if (data.toString().includes('POUNDINGCORE_LISTENING')) {
      clearTimeout(timeout);
      resolve();
    }
  });
  backend.stderr.on('data', (d) => process.stderr.write(d));
  backend.on('error', reject);
});

console.log('Backend ready. Running Playwright tests...\n');

// Run tests
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const results = [];

// T1: API assistants
try {
  const resp = await page.goto(`${BASE}/api/assistants`, { timeout: 5000 });
  const json = await resp.json();
  const count = json.data?.length ?? 0;
  results.push(`${count === 45 ? '✅' : '❌'} T1: /api/assistants → ${count} assistants`);
} catch(e) { results.push(`❌ T1: ${e.message.slice(0,100)}`); }

// T2: slash-commands (no agent)
try {
  const resp = await page.goto(`${BASE}/api/conversations/fake/slash-commands`, { timeout: 5000 });
  const json = await resp.json();
  const ok = resp.status() === 200 && json.success === true;
  results.push(`${ok ? '✅' : '❌'} T2: /api/conversations/fake/slash-commands → ${resp.status()} ${json.success ? 'ok' : 'fail'}`);
} catch(e) { results.push(`❌ T2: ${e.message.slice(0,100)}`); }

// T3: model switch (no agent)
try {
  await page.goto(`${BASE}/api/conversations/fake/model`);
  const resp = await page.evaluate(() =>
    fetch('/api/conversations/fake/model', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: 'deepseek-v4-pro' })
    }).then(r => r.json())
  );
  const ok = resp.success === true;
  results.push(`${ok ? '✅' : '❌'} T3: PUT /api/conversations/fake/model → ${ok ? '200 ok' : 'fail'}`);
} catch(e) { results.push(`❌ T3: ${e.message.slice(0,100)}`); }

// T4: login page exists
try {
  const resp = await page.goto(`${BASE}/login`, { timeout: 5000 });
  results.push(`${resp.status() < 500 ? '✅' : '❌'} T4: /login → ${resp.status()}`);
} catch(e) { results.push(`❌ T4: ${e.message.slice(0,100)}`); }

console.log(results.join('\n'));
await browser.close();
backend.kill();
rmSync(tmpDir, { recursive: true, force: true });
console.log('\nDone.');
