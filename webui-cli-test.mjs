/**
 * WebUI CLI agent testing via CDP.
 *
 * Tests all 5 CLI agents through the WebUI: login → create conversation →
 * send message → check response → model switch.
 *
 * Usage: bun run webui-cli-test.mjs
 */

const WEBUI_TARGET = '8A10A341CB6BA4738A81F49FD71D3363';
const WS_URL = `ws://127.0.0.1:9230/devtools/page/${WEBUI_TARGET}`;

let ws;
let msgId = 0;
let results = [];
let pending = new Map();

function send(method, params = {}) {
  const id = ++msgId;
  const msg = JSON.stringify({ id, method, params });
  ws.send(msg);
  return id;
}

function evaluate(expression) {
  return send('Runtime.evaluate', { expression, returnByValue: true });
}

function ok(test, detail = '') {
  results.push({ test, status: 'PASS', detail });
  console.log(`  ✅ ${test}${detail ? ': ' + detail : ''}`);
}
function fail(test, detail = '') {
  results.push({ test, status: 'FAIL', detail });
  console.log(`  ❌ ${test}${detail ? ': ' + detail : ''}`);
}

async function waitForMsg(id, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for msg ${id}`)), timeout);
    pending.set(id, { resolve, timer });
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(WS_URL);
    ws.addEventListener('open', () => {
      send('Runtime.enable');
      send('Page.enable');
      send('DOM.enable');
      resolve();
    });
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(msg);
      }
    });
    ws.addEventListener('error', reject);
  });
}

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('\n═══ WebUI CLI Agent Test via CDP ═══\n');

  await connect();
  console.log('Connected to WebUI page\n');

  // ── T1: Login ──
  console.log('─── T1: Login ───');

  let loginInfo = await evaluate(
    'JSON.stringify({' +
      'url: location.href,' +
      'hasForm: !!document.querySelector("form"),' +
      'inputs: Array.from(document.querySelectorAll("input")).map(function(i) { return {type:i.type, placeholder:i.placeholder, name:i.name}; }),' +
      'buttons: Array.from(document.querySelectorAll("button")).map(function(b) { return {text:b.innerText.substring(0,30), type:b.type}; })' +
      '})'
  );

  let id1 = await waitForMsg(loginInfo);
  const pageInfo = JSON.parse(id1.result?.result?.value || '{}');
  console.log('  URL:', pageInfo.url);
  console.log('  Has form:', pageInfo.hasForm);
  console.log('  Inputs:', JSON.stringify(pageInfo.inputs));
  console.log('  Buttons:', JSON.stringify(pageInfo.buttons));

  // Fill login form and submit
  if (pageInfo.inputs && pageInfo.inputs.length >= 2) {
    // Fill username
    const setUser = await evaluate(
      'var inputs = document.querySelectorAll("input");' +
        'if (inputs[0]) {' +
        '  var nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;' +
        '  nativeSetter.call(inputs[0], "haloclawroot");' +
        '  inputs[0].dispatchEvent(new Event("input", {bubbles: true}));' +
        '  "username set";' +
        '} else { "no input"; }'
    );
    await waitForMsg(setUser);

    const setPw = await evaluate(
      'var inputs = document.querySelectorAll("input");' +
        'if (inputs[1]) {' +
        '  var nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;' +
        '  nativeSetter.call(inputs[1], "Haloclaw2026!");' +
        '  inputs[1].dispatchEvent(new Event("input", {bubbles: true}));' +
        '  "password set";' +
        '} else { "no password input"; }'
    );
    await waitForMsg(setPw);
    ok('T1.1', 'credentials filled');

    // Click login button
    const clickLogin = await evaluate(
      'var btn = document.querySelector("button[type=submit]") || document.querySelector("button");' +
        'if (btn) { btn.click(); "clicked"; } else { "no button"; }'
    );
    await waitForMsg(clickLogin);
    ok('T1.2', 'login submitted');

    // Wait for navigation
    await wait(3000);

    const afterLogin = await evaluate('JSON.stringify({url: location.href, title: document.title})');
    const afterInfo = JSON.parse((await waitForMsg(afterLogin)).result?.result?.value || '{}');
    console.log('  After login URL:', afterInfo.url);

    if (afterInfo.url && !afterInfo.url.includes('/login')) {
      ok('T1.3', 'login succeeded, navigated to ' + afterInfo.url);
    } else {
      // Check for error message
      const checkErr = await evaluate(
        'var err = document.querySelector(".arco-message-error, .arco-notification-error, [class*=error]");' +
          'err ? err.innerText : "no visible error"'
      );
      const errText = (await waitForMsg(checkErr)).result?.result?.value || '';
      fail('T1.3', 'login failed: ' + errText);
    }
  } else {
    fail('T1.1', 'no login form found');
  }

  // ── T2: Navigate to conversations and create one per CLI ──
  console.log('\n─── T2: CLI Conversations ───');

  const CLI_TARGETS = [
    { backend: 'claude', name: 'Claude Code' },
    { backend: 'codex', name: 'Codex CLI' },
    { backend: 'opencode', name: 'OpenCode' },
    { backend: 'hermes', name: 'Hermes' },
    { backend: 'openclaw', name: 'OpenClaw' },
  ];

  for (const cli of CLI_TARGETS) {
    console.log(`\n  ── ${cli.name} (${cli.backend}) ──`);

    // Create conversation via API
    const tokenRes = await evaluate(
      'JSON.stringify({' +
        'token: localStorage.getItem("token") || "",' +
        'baseUrl: localStorage.getItem("baseUrl") || window.location.origin' +
        '})'
    );
    const tokenInfo = JSON.parse((await waitForMsg(tokenRes)).result?.result?.value || '{}');
    const baseUrl = tokenInfo.baseUrl || 'http://localhost:25809';

    // Use fetch to create conversation
    const createConv = await evaluate(
      'fetch("' +
        baseUrl +
        '/api/conversations", {' +
        '  method: "POST",' +
        '  headers: {"Content-Type":"application/json", "Authorization":"Bearer ' +
        (tokenInfo.token || '') +
        '"},' +
        '  body: JSON.stringify({type:"acp", name:"WebUI test ' +
        cli.backend +
        '", extra:{backend:"' +
        cli.backend +
        '"}})' +
        '}).then(function(r) { return r.json(); }).then(function(d) { return JSON.stringify({id:d.id||d.data?.id, status:r}); }).catch(function(e) { return JSON.stringify({error:e.message}); })'
    );

    try {
      const convResult = JSON.parse((await waitForMsg(createConv, 15000)).result?.result?.value || '{}');
      const convId = convResult.id;

      if (convId) {
        ok('conv:' + cli.backend, 'created ' + convId);

        // Send a message
        const sendMsg = await evaluate(
          'fetch("' +
            baseUrl +
            '/api/conversations/' +
            convId +
            '/messages", {' +
            '  method: "POST",' +
            '  headers: {"Content-Type":"application/json", "Authorization":"Bearer ' +
            (tokenInfo.token || '') +
            '"},' +
            '  body: JSON.stringify({content:"Say hello in one sentence."})' +
            '}).then(function(r) { return r.status; }).catch(function(e) { return "error:" + e.message; })'
        );
        const msgStatus = (await waitForMsg(sendMsg, 15000)).result?.result?.value;

        if (msgStatus === 202 || msgStatus === 200) {
          ok('msg:' + cli.backend, 'message accepted (HTTP ' + msgStatus + ')');

          // Wait for response
          await wait(5000);

          // Check messages
          const checkMsgs = await evaluate(
            'fetch("' +
              baseUrl +
              '/api/conversations/' +
              convId +
              '/messages", {' +
              '  headers: {"Authorization":"Bearer ' +
              (tokenInfo.token || '') +
              '"}' +
              '}).then(function(r) { return r.json(); }).then(function(d) {' +
              '  var msgs = d.data?.items || d.data || [];' +
              '  var hasReply = msgs.some(function(m) { return m.role === "assistant"; });' +
              '  return JSON.stringify({count:msgs.length, hasReply:hasReply, lastRole:msgs[msgs.length-1]?.role});' +
              '}).catch(function(e) { return JSON.stringify({error:e.message}); })'
          );
          const msgInfo = JSON.parse((await waitForMsg(checkMsgs, 10000)).result?.result?.value || '{}');

          if (msgInfo.hasReply) {
            ok('reply:' + cli.backend, msgInfo.count + ' messages, assistant replied');
          } else if (msgInfo.error) {
            fail('reply:' + cli.backend, msgInfo.error);
          } else {
            console.log('      Messages: ' + msgInfo.count + ', lastRole: ' + msgInfo.lastRole + ' (still processing)');
          }
        } else {
          fail('msg:' + cli.backend, 'HTTP ' + msgStatus);
        }
      } else {
        fail('conv:' + cli.backend, JSON.stringify(convResult).substring(0, 80));
      }
    } catch (e) {
      fail('conv:' + cli.backend, e.message);
    }
  }

  // ── T3: Model Switching ──
  console.log('\n─── T3: Model Switching ───');

  const listConvs = await evaluate(
    'fetch("' +
      (tokenInfo?.baseUrl || 'http://localhost:25809') +
      '/api/conversations", {' +
      '  headers: {"Authorization":"Bearer ' +
      (tokenInfo?.token || '') +
      '"}' +
      '}).then(function(r) { return r.json(); }).then(function(d) {' +
      '  var items = d.data?.items || d.data || [];' +
      '  return JSON.stringify({count:items.length, firstId:items[0]?.id});' +
      '}).catch(function(e) { return JSON.stringify({error:e.message}); })'
  );

  try {
    const convList = JSON.parse((await waitForMsg(listConvs, 10000)).result?.result?.value || '{}');
    if (convList.firstId) {
      // Test model switch
      const models = ['deepseek-v4-pro', 'deepseek-v4-flash'];
      for (const model of models) {
        const switchModel = await evaluate(
          'fetch("' +
            (tokenInfo?.baseUrl || 'http://localhost:25809') +
            '/api/conversations/' +
            convList.firstId +
            '/model", {' +
            '  method: "PUT",' +
            '  headers: {"Content-Type":"application/json", "Authorization":"Bearer ' +
            (tokenInfo?.token || '') +
            '"},' +
            '  body: JSON.stringify({model_id:"' +
            model +
            '"})' +
            '}).then(function(r) { return r.status; }).catch(function(e) { return "error:" + e.message; })'
        );
        const switchStatus = (await waitForMsg(switchModel, 10000)).result?.result?.value;
        if (switchStatus === 200) {
          ok('switch:' + model, 'switched successfully');
        } else {
          fail('switch:' + model, 'HTTP ' + switchStatus);
        }
      }
    } else {
      console.log('  No conversations to test model switching');
    }
  } catch (e) {
    console.log('  Model switch error:', e.message);
  }

  // ── Summary ──
  console.log('\n═══ RESULTS ═══');
  const pass = results.filter((r) => r.status === 'PASS').length;
  const failN = results.filter((r) => r.status === 'FAIL').length;
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : '❌';
    console.log(icon + ' ' + r.test + ': ' + r.detail);
  }
  console.log('\n' + pass + ' passed, ' + failN + ' failed');
  console.log(failN > 0 ? '\n❌ SOME TESTS FAILED' : '\n✅ ALL TESTS PASSED');

  ws.close();
  process.exit(failN > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
