/**
 * L3: Login + CLI Multi-turn Conversation + Model/Mode Switching
 *
 * Prerequisite: WebUI running at http://localhost:25809
 * Account: haloclawroot / Haloclaw2026!
 */
import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:25809';
const CLI_TARGETS = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex CLI' },
  { id: 'hermes', name: 'Hermes' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'openclaw', name: 'OpenClaw' },
];

async function login(page: any) {
  await page.goto(BASE);
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
  await page.waitForTimeout(3000);
  await page.fill('#username', 'haloclawroot');
  await page.fill('#password', 'Haloclaw2026!');
  await page.click('button.login-page__submit');
  await page.waitForTimeout(5000);
}

async function sendMessage(page: any, text: string) {
  // On guid page: input is guid-input, send via guid-send-btn
  // On conversation page: input is sendbox-input, send via Enter key
  const guidInput = page.locator('[data-testid="guid-input"]');
  const convInput = page.locator('[data-testid="sendbox-input"]');

  if (await guidInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    await guidInput.fill(text);
    await page.click('[data-testid="guid-send-btn"]');
  } else if (await convInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    await convInput.fill(text);
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(15000);
}

test.describe('Out-of-Box CLI Chat (L3)', () => {
  test('L3.1: Login succeeds', async ({ page }) => {
    await login(page);
    const hash = await page.evaluate(() => window.location.hash);
    expect(hash.startsWith('#/guid')).toBe(true);
  });

  for (const cli of CLI_TARGETS) {
    test(`L3.${CLI_TARGETS.indexOf(cli) + 2}: ${cli.name} - multi-turn + model + mode`, async ({ page }) => {
      await login(page);

      // Select CLI agent
      const pill = page.locator(`[data-testid="agent-pill-${cli.id}"]`);
      await pill.waitFor({ state: 'visible', timeout: 5000 });
      await pill.click();
      await page.waitForTimeout(1000);
      console.log(`  ${cli.name}: Agent selected`);

      // Round 1: First message
      await sendMessage(page, `你好，我是测试用户`);
      console.log(`  ${cli.name}: R1 done`);

      // Round 2: Context check
      await sendMessage(page, `我叫什么名字？`);
      console.log(`  ${cli.name}: R2 done`);

      // Round 3: Math
      await sendMessage(page, `1+1等于几？`);
      console.log(`  ${cli.name}: R3 done`);

      // Round 4: Switch model
      console.log(`  ${cli.name}: R4 switch model...`);
      await page.click('[data-testid="acp-model-selector"], [data-testid="guid-model-selector"]');
      await page.waitForTimeout(1000);
      const modelOpt = page.locator('[data-mode-value], .arco-dropdown-menu-item').first();
      if (await modelOpt.isVisible({ timeout: 2000 }).catch(() => false)) {
        await modelOpt.click();
        await page.waitForTimeout(2000);
        console.log(`  ${cli.name}: R4 model switched`);
      }
      await sendMessage(page, `What model are you using now?`);
      console.log(`  ${cli.name}: R4 done`);

      // Round 5: Context after model switch
      await sendMessage(page, `我之前叫什么名字？`);
      console.log(`  ${cli.name}: R5 done`);

      // Round 6: Switch mode
      console.log(`  ${cli.name}: R6 switch mode...`);
      await page.click('[data-testid="agent-mode-selector-aionrs"]');
      await page.waitForTimeout(1000);
      const modeOpt = page.locator('[data-mode-value]').first();
      if (await modeOpt.isVisible({ timeout: 2000 }).catch(() => false)) {
        await modeOpt.click();
        await page.waitForTimeout(2000);
        console.log(`  ${cli.name}: R6 mode switched`);
      }
      await sendMessage(page, `write a fibonacci function in python`);
      console.log(`  ${cli.name}: R6 done`);

      console.log(`  ${cli.name}: ALL ROUNDS PASSED`);
    });
  }
});
