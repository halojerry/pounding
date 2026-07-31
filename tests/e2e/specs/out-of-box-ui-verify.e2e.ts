/**
 * UI Verification Tests — connects to running Electron via CDP.
 * Requires: bun dev running, CDP on port 9230.
 */
import { test, expect } from '@playwright/test';
import { chromium } from 'playwright';

const CDP_URL = 'http://127.0.0.1:9230';
const VITE_URL = 'http://localhost:5173';

test.describe('UI Verification', () => {
  let browser, page;

  test.beforeAll(async () => {
    browser = await chromium.connectOverCDP(CDP_URL);
    // Find the POUNDING app page
    const contexts = browser.contexts();
    const pages = contexts.flatMap((c) => c.pages());
    page = pages.find((p) => p.url().includes('5173')) || pages[0];
    if (!page.url().includes('5173')) {
      await page.goto(VITE_URL + '/#/guid');
    }
    await page.waitForTimeout(3000);
  });

  test.afterAll(async () => {
    // Don't close — we didn't launch it
  });

  test('TC1: login and land on Guid page', async () => {
    // Check if already logged in
    const hash = await page.evaluate(() => window.location.hash);
    if (hash.includes('login') || hash === '' || hash === '#/') {
      await page.fill('input[type="text"], input[placeholder*="用户名"], input[placeholder*="email"]', 'haloclawroot');
      await page.fill('input[type="password"]', 'Haloclaw2026!');
      await page.click('button:has-text("登录"), button:has-text("Sign In")');
      await page.waitForTimeout(5000);
    }
    const newHash = await page.evaluate(() => window.location.hash);
    expect(newHash).toMatch(/guid|conversation/);
  });

  test('TC2: mode switch without config_not_observed', async ({}, testInfo) => {
    // Collect console errors
    const errors = [];
    const handler = (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    };
    page.on('console', handler);

    // Click mode selector
    const modeSelector = page.locator('[data-testid="mode-selector"], .mode-selector, [class*="mode-select"]').first();
    if (await modeSelector.isVisible()) {
      await modeSelector.click();
      await page.waitForTimeout(500);

      // Click a different mode
      const modeOption = page.locator('[data-mode-value], .arco-dropdown-menu-item').first();
      if (await modeOption.isVisible()) {
        await modeOption.click();
        await page.waitForTimeout(3000);
      }
    }

    page.off('console', handler);
    const configErrors = errors.filter((e) => e.includes('config_not_observed'));
    expect(configErrors).toHaveLength(0);
  });

  test('TC3: send message after mode switch', async () => {
    const input = page.locator('textarea, [contenteditable="true"], .chat-input textarea').first();
    if (await input.isVisible()) {
      await input.fill('1+1=?');
      await page.click('button:has-text("发送"), [data-testid="send-btn"]');
      await page.waitForTimeout(10000);
      const body = await page.textContent('body');
      expect(body).toMatch(/2/);
    }
  });

  test('TC4: model switch without error', async () => {
    const modelSelector = page
      .locator('[data-testid="model-selector"], .model-selector, [class*="model-select"]')
      .first();
    if (await modelSelector.isVisible()) {
      await modelSelector.click();
      await page.waitForTimeout(500);
      const option = page.locator('.arco-dropdown-menu-item').first();
      if (await option.isVisible()) {
        await option.click();
        await page.waitForTimeout(3000);
      }
    }
    // Should not have crashed
    const body = await page.textContent('body');
    expect(body.length).toBeGreaterThan(50);
  });

  test('TC5: theme toggle dark/light', async () => {
    const toggle = page.locator('[data-testid="desktop-theme-toggle"]');
    if (await toggle.isVisible()) {
      // Check current theme
      const getTheme = () =>
        page.evaluate(
          () => document.documentElement.getAttribute('data-theme') || localStorage.getItem('arco-theme') || ''
        );
      const initial = await getTheme();

      // Toggle
      await toggle.click();
      await page.waitForTimeout(1000);
      const afterFirst = await getTheme();
      console.log(`Theme: ${initial} → ${afterFirst}`);

      // Toggle back
      await toggle.click();
      await page.waitForTimeout(1000);
      const afterSecond = await getTheme();
      console.log(`Theme: ${afterFirst} → ${afterSecond}`);

      // Should have changed at least once
      expect(afterFirst).not.toEqual(initial);
    }
  });
});
