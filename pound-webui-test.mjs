/**
 * POUNDING end-to-end test: real CLI conversation testing via HTTP API.
 *
 * Tests:
 *   T1 - Backend startup & auth status
 *   T2 - WebUI credential sync + login
 *   T3 - Create conversations with each CLI agent + send messages
 *   T4 - Model switching
 *   T5 - Skills & assistants available
 *
 * Usage: bun run pound-webui-test.mjs
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const BACKEND_BIN = '/Users/halo/Documents/pounding desktop/AionCore/target/debug/poundingcore';
const PORT = 25877; // unique port to avoid conflicts
const BASE = `http://127.0.0.1:${PORT}`;

let backend;
let tmpDir;
let results = [];

function ok(test, detail = '') {
  results.push({ test, status: 'PASS', detail });
  console.log(`  ✅ ${test}${detail ? ': ' + detail : ''}`);
}
function fail(test, detail = '') {
  results.push({ test, status: 'FAIL', detail });
  console.log(`  ❌ ${test}${detail ? ': ' + detail : ''}`);
}

let authToken = '';

async function api(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(`${BASE}${path}`, opts);
    const text = await res.text();
    try {
      return { status: res.status, data: JSON.parse(text) };
    } catch {
      return { status: res.status, data: text };
    }
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

// ── Start backend ──
console.log('\n═══ POUNDING E2E CLI Test ═══\n');

tmpDir = mkdtempSync(join(tmpdir(), 'pound-e2e-'));
console.log(`Starting backend on ${PORT}...`);
backend = spawn(BACKEND_BIN, ['--port', String(PORT), '--local', '--data-dir', tmpDir], { stdio: 'pipe' });

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('Backend timeout')), 20000);
  backend.stdout.on('data', (d) => {
    if (d.toString().includes('POUNDINGCORE_LISTENING')) {
      clearTimeout(t);
      resolve();
    }
  });
  backend.stderr.on('data', (d) => process.stderr.write(d));
  backend.on('error', reject);
});

console.log('Backend ready.\n');

// ── T1: Auth status ──
console.log('─── T1: Auth & Login ───');
{
  const r = await api('GET', '/api/auth/status');
  if (r.status === 200 && r.data.success) ok('T1.1 auth/status', `needs_setup=${r.data.needs_setup}`);
  else fail('T1.1 auth/status', r.data?.error || r.error || `${r.status}`);

  // Sync credentials
  const sync = await api('POST', '/api/auth/internal/users/sync-credentials', {
    username: 'test',
    password: 'test123',
  });
  if (sync.status === 200 && sync.data?.success) ok('T1.2 sync-credentials');
  else fail('T1.2 sync-credentials', sync.data?.error || sync.error || `${sync.status}`);

  // Login with synced credentials
  const login = await api('POST', '/login', { username: 'test', password: 'test123' });
  if (login.status === 200 && login.data?.success) {
    authToken = login.data.token;
    ok('T1.3 login with synced pw', `token=${authToken?.slice(0, 20)}...`);
  } else fail('T1.3 login', login.data?.error || login.error || `${login.status}`);
}

// ── T2: Agents available ──
console.log('\n─── T2: Agents ───');
{
  const r = await api('GET', '/api/agents');
  if (r.status === 200 && r.data?.success) {
    const agents = r.data.data || [];
    ok('T2.1 agents list', `${agents.length} agents`);
    for (const a of agents) {
      const icon = a.available ? '✅' : '❌';
      console.log(`      ${icon} ${a.name} (${a.backend || '?'}) — ${a.available ? 'available' : 'unavailable'}`);
      if (a.status === 'available' && a.backend) {
        results.push({ test: `agent:${a.backend}`, status: 'AVAILABLE', detail: a.name });
      }
    }
  } else {
    fail('T2.1 agents', r.data?.error || r.error || `${r.status}`);
  }
}

// ── T3: Skills ──
console.log('\n─── T3: Skills ───');
{
  const r = await api('GET', '/api/skills');
  if (r.status === 200 && r.data?.success) {
    const skills = r.data.data || [];
    ok('T3.1 skills list', `${skills.length} skills`);
  } else fail('T3.1 skills', r.data?.error || r.error || `${r.status}`);

  const r2 = await api('GET', '/api/assistants');
  if (r2.status === 200 && r2.data?.success) {
    const assts = r2.data.data || [];
    ok('T3.2 assistants', `${assts.length} assistants`);
    // Check first assistant has skills
    if (assts.length > 0) {
      const first = assts[0];
      const skillIds = first.default_skill_ids || first.enabled_skills || [];
      console.log(
        `      Assistant "${first.name}": skills=${skillIds.length > 0 ? skillIds.slice(0, 5).join(',') + '...' : 'NONE ⚠️'}`
      );
      if (skillIds.length === 0) fail('T3.3 assistant skills', `${first.name} has no skills`);
      else ok('T3.3 assistant skills', `${first.name}: ${skillIds.length} skills`);
    }
  } else fail('T3.2 assistants', r2.data?.error || r2.error || `${r2.status}`);
}

// ── T4: Create conversation & send message per CLI ──
console.log('\n─── T4: CLI Conversations ───');

// Find available CLI agents first
const agentsRes = await api('GET', '/api/agents');
const availableAgents = (agentsRes.data?.data || []).filter((a) => a.available && a.agent_type === 'acp');

// Test Claude, Codex, OpenCode, Hermes, OpenClaw
const CLI_TARGETS = ['claude', 'codex', 'opencode', 'hermes', 'openclaw'];

for (const target of CLI_TARGETS) {
  const agent = availableAgents.find((a) => a.backend === target);
  if (!agent) {
    console.log(`  ⏭️ ${target}: agent not available, skipping`);
    results.push({ test: `cli:${target}`, status: 'SKIP', detail: 'agent unavailable' });
    continue;
  }
  console.log(`\n  ── ${target} (${agent.name}) ──`);

  // T4.1: Create conversation
  const create = await api('POST', '/api/conversations', {
    type: 'acp',
    name: `E2E test ${target}`,
    extra: { backend: target },
  });

  const statusOk = create.status === 200 || create.status === 201;
  if (!statusOk || !(create.data?.success || create.status === 201)) {
    fail(
      `T4 conv:${target} create`,
      `${create.status}: ${create.data?.error || JSON.stringify(create.data).slice(0, 80)}`
    );
    continue;
  }

  const convId = create.data?.id || create.data?.data?.id;
  if (!convId) {
    fail(`T4 conv:${target} create`, 'no conversation id in response');
    continue;
  }
  ok(`T4 conv:${target} create`, convId);

  // T4.2: Check config-options (should not 404)
  const co = await api('GET', `/api/conversations/${convId}/config-options`);
  if (co.status === 200 && co.data?.success)
    ok(`T4 config:${target}`, `config_options=${(co.data?.data?.config_options || []).length}`);
  else fail(`T4 config:${target}`, `HTTP ${co.status}: ${co.data?.error || co.error || ''}`);

  // T4.3: Get model info
  const model = await api('GET', `/api/conversations/${convId}/model`);
  if (model.status === 200 && model.data?.success !== false)
    ok(`T4 model:${target}`, `model=${JSON.stringify(model.data?.data?.model_info || model.data).slice(0, 50)}`);
  else fail(`T4 model:${target}`, `HTTP ${model.status}`);

  // T4.4: Get slash-commands
  const sc = await api('GET', `/api/conversations/${convId}/slash-commands`);
  if (sc.status === 200 && sc.data?.success) ok(`T4 slash:${target}`, `${(sc.data?.data || []).length} commands`);
  else fail(`T4 slash:${target}`, `HTTP ${sc.status}`);

  // T4.5: Send a message to the CLI agent
  const send = await api('POST', `/api/conversations/${convId}/messages`, {
    content: 'Say hello in one sentence.',
  });

  if (send.status === 202 || send.status === 200) {
    ok(`T4 send:${target}`, `msg_id=${send.data?.data?.msg_id || '?'} turn_id=${send.data?.data?.turn_id || '?'}`);
    // Check for errors
    if (send.data?.error) fail(`T4 result:${target}`, send.data.error);
    else if (send.data?.success === false) fail(`T4 result:${target}`, 'unknown error');
    else ok(`T4 result:${target}`, 'message sent');
  } else {
    fail(`T4 send:${target}`, `HTTP ${send.status}: ${send.data?.error || JSON.stringify(send.data).slice(0, 100)}`);
  }

  // Briefly wait for agent to process, then check turn status
  await new Promise((r) => setTimeout(r, 3000));

  // Check conversation status
  const conv = await api('GET', `/api/conversations/${convId}`);
  const status = conv.data?.data?.runtime?.status || conv.data?.status || 'unknown';
  const lastError = conv.data?.data?.runtime?.last_error || '';
  if (lastError) fail(`T4 conv:${target} runtime`, lastError);
  else console.log(`      Status: ${status}`);
}

// ── T5: Model switch ──
console.log('\n─── T5: Model Switching ───');
{
  // Use the first successfully-created conversation
  const convs = await api('GET', '/api/conversations');
  const list = convs.data?.data || convs.data || [];
  const firstConv = Array.isArray(list) ? list[0] : null;

  if (firstConv?.id) {
    const cid = firstConv.id;
    const models = ['deepseek-v4-pro', 'deepseek-v4-flash', 'MiniMax-M2.7-highspeed'];
    for (const m of models) {
      const sw = await api('PUT', `/api/conversations/${cid}/model`, { model_id: m });
      if (sw.status === 200 && sw.data?.success) ok(`T5 switch:${m}`);
      else fail(`T5 switch:${m}`, sw.data?.error || sw.error || `${sw.status}`);
    }
  }
}

// ── Summary ──
console.log('\n═══ RESULTS ═══');
const pass = results.filter((r) => r.status === 'PASS').length;
const failN = results.filter((r) => r.status === 'FAIL').length;
const skip = results.filter((r) => r.status === 'SKIP' || r.status === 'AVAILABLE').length;

for (const r of results) {
  const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : r.status === 'SKIP' ? '⏭️' : '  ';
  console.log(`${icon} ${r.test}: ${r.detail}`);
}

console.log(`\n${pass} passed, ${failN} failed, ${skip} skipped/available`);
console.log(failN > 0 ? '\n❌ SOME TESTS FAILED' : '\n✅ ALL TESTS PASSED');

// Cleanup
backend.kill();
rmSync(tmpDir, { recursive: true, force: true });
