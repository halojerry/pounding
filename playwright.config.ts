import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  // Release OOB gate launches the packaged app and waits for the backend to
  // become ready before the main window appears (index.ts creates the window
  // after markBackendReady). On slow/Intel/Rosetta runners that cold start can
  // exceed 60s, which made the page fixture time out before the test body even
  // ran (PR #20 extended the body wait but not the fixture setup). Use a global
  // timeout large enough to cover the whole launch, not just the test body.
  timeout: 300_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // Electron tests share one app instance
  retries: process.env.CI ? 1 : 0,
  workers: 1, // Must be 1: tests share a singleton Electron app instance
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'tests/e2e/report' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'tests/e2e/report' }]],
  use: {
    trace: process.env.E2E_TRACE === '1' ? 'retain-on-failure' : 'on-first-retry',
    // screenshot/video are handled by our custom Electron fixture (see fixtures.ts)
    // since Playwright's built-in auto-screenshot requires its own `page` fixture.
    screenshot: 'only-on-failure',
    video: process.env.E2E_TRACE === '1' ? 'retain-on-failure' : 'on-first-retry',
  },
  outputDir: 'tests/e2e/results',
});
