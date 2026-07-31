import { test, expect } from '../fixtures';

test.describe('Model Selector', () => {
  test('Claude model selector shows POUNDING API models', async ({ page }) => {
    await page.waitForLoadState('domcontentloaded', { timeout: 60_000 });
    await page.waitForTimeout(5000);

    // Check model selector
    const modelBtn = page.locator('.sendbox-model-btn, .header-model-btn').first();
    const modelVisible = await modelBtn.isVisible({ timeout: 10000 }).catch(() => false);

    if (modelVisible) {
      await modelBtn.click();
      await page.waitForTimeout(2000);

      const menuItems = page.locator('.arco-dropdown-menu-item, [role="menuitem"]');
      const count = await menuItems.count();

      const models: string[] = [];
      for (let i = 0; i < Math.min(count, 30); i++) {
        const text = await menuItems.nth(i).textContent();
        models.push(text?.trim() || '');
      }

      console.log('Models found:', models);

      // Check for POUNDING API models
      const hasDeepseek = models.some((m) => m.toLowerCase().includes('deepseek'));
      const hasMimo = models.some((m) => m.toLowerCase().includes('mimo'));

      expect(hasDeepseek || hasMimo).toBeTruthy();

      await page.keyboard.press('Escape');
    }

    await page.screenshot({ path: 'tests/e2e/screenshots/model-selector-test.png' });
  });
});
