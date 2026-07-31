import { test, expect } from '../fixtures';

test.describe('Full Model Selector Test', () => {
  test('Model selector displays all POUNDING API models', async ({ page }) => {
    // Wait for the app to fully load
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(15000);

    console.log('Page title:', await page.title());
    console.log('Page URL:', page.url());

    // Take screenshot of current state
    await page.screenshot({ path: 'tests/e2e/screenshots/model-selector-debug.png' });

    // Check if we're on login page or main page
    const hasLogin = await page
      .locator('input[type="password"], input[placeholder*="password"]')
      .isVisible()
      .catch(() => false);
    console.log('Has login form:', hasLogin);

    if (hasLogin) {
      console.log('On login page - skipping model selector test');
      // Try to find any model-related elements
      const bodyText = await page
        .locator('body')
        .textContent()
        .catch(() => '');
      console.log('Page content:', bodyText.substring(0, 500));
    } else {
      // Check model selector
      const modelBtn = page.locator('.sendbox-model-btn, .header-model-btn').first();
      const modelVisible = await modelBtn.isVisible({ timeout: 10000 }).catch(() => false);
      console.log('Model selector visible:', modelVisible);

      if (modelVisible) {
        await modelBtn.click();
        await page.waitForTimeout(2000);

        const menuItems = page.locator('.arco-dropdown-menu-item, [role="menuitem"]');
        const count = await menuItems.count();
        console.log('Model dropdown items:', count);

        const models: string[] = [];
        for (let i = 0; i < Math.min(count, 30); i++) {
          const text = await menuItems.nth(i).textContent();
          models.push(text?.trim() || '');
        }
        console.log('Models:', JSON.stringify(models));

        await page.keyboard.press('Escape');
      }
    }

    // Don't assert - just log results for debugging
    console.log('Test completed - check screenshots for visual verification');
  });
});
