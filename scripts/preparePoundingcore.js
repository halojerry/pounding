/**
 * CLI wrapper for prepare-poundingcore.
 *
 * Reads environment variables and invokes the shared module.
 *
 * Version resolution order:
 *  1. POUNDING_BACKEND_RUN_ID env (download from poundingcore Manual Build artifact)
 *  2. POUNDING_BACKEND_VERSION env (for ad-hoc release overrides)
 *  3. "poundingcoreVersion" field in repo-root package.json (the pin)
 *  4. 'latest' (fallback; not recommended for reproducible builds)
 *
 * Environment variables:
 *  - POUNDING_BACKEND_RUN_ID: poundingcore Manual Build workflow run id
 *  - POUNDING_BACKEND_VERSION: override the pinned version
 *  - POUNDING_BACKEND_ARCH: target architecture (default: process.arch)
 *  - GH_TOKEN / GITHUB_TOKEN: GitHub API token (for rate limiting)
 */

const path = require('path');
const { preparePoundingcore } = require('../packages/shared-scripts/src/prepare-poundingcore.js');
const { resolvePoundingcoreVersion } = require('./resolvePoundingcoreVersion.js');

const projectRoot = path.resolve(__dirname, '..');
const platform = process.platform;
// Support cross-compilation: POUNDING_BACKEND_ARCH > npm_config_target_arch > process.arch
const arch = process.env.POUNDING_BACKEND_ARCH || process.env.npm_config_target_arch || process.arch;
const version = resolvePoundingcoreVersion(projectRoot);

try {
  preparePoundingcore({ projectRoot, platform, arch, version });
} catch (error) {
  console.error('❌ preparePoundingcore failed:', error.message);
  process.exit(1);
}

module.exports = function () {
  try {
    return preparePoundingcore({ projectRoot, platform, arch, version });
  } catch (error) {
    console.error('❌ preparePoundingcore failed:', error.message);
    throw error;
  }
};
