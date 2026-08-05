/**
 * L2: WebUI Smoke Tests — no login required.
 *
 * Start WebUI first: bun run webui
 */
import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:25809';

test.describe('Out-of-Box WebUI', () => {
  test('TC2.1: page loads without uncaught errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });

    expect(errors.filter((e) => !e.includes('ResizeObserver') && !e.includes('hydration'))).toHaveLength(0);
  });

  test('TC2.2: POUNDING branding, no POUNDING residue', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });

    const bodyText = await page.textContent('body');
    expect(bodyText).not.toContain('POUNDING');
  });

  test('TC2.3: page has a title', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });

    const title = await page.title();
    expect(title).toBeTruthy();
  });

  test('TC2.4: page renders app content', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
    await page.waitForTimeout(3000); // Wait for SPA to hydrate

    const bodyText = await page.textContent('body');
    const len = bodyText?.length || 0;
    console.log(`  Body length: ${len}`);
    expect(len).toBeGreaterThan(50); // Page should have meaningful content
  });
});
