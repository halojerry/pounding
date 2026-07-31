import { describe, expect, it } from 'vitest';

const {
  getActionsArtifactName,
  getActionsArtifactMissingMessage,
} = require('../../../packages/shared-scripts/src/prepare-poundingcore');

describe('prepare-poundingcore GitHub Actions artifact resolver', () => {
  it.each([
    ['win32', 'x64', 'poundingcore-manual-windows-x64'],
    ['win32', 'arm64', 'poundingcore-manual-windows-arm64'],
    ['darwin', 'x64', 'poundingcore-manual-macos-x64'],
    ['darwin', 'arm64', 'poundingcore-manual-macos-arm64'],
    ['linux', 'x64', 'poundingcore-manual-linux-x64'],
    ['linux', 'arm64', 'poundingcore-manual-linux-arm64'],
  ])('maps %s-%s to %s', (platform, arch, artifactName) => {
    expect(getActionsArtifactName(platform, arch)).toBe(artifactName);
  });

  it('explains which poundingcore manual artifact is missing for the requested platform', () => {
    expect(
      getActionsArtifactMissingMessage({
        runId: '27319522909',
        platform: 'win32',
        arch: 'x64',
        expectedArtifactName: 'poundingcore-manual-windows-x64',
        availableArtifactNames: ['poundingcore-manual-macos-arm64', 'poundingcore-manual-linux-x64'],
      })
    ).toBe(
      [
        'poundingcore run 27319522909 does not contain artifact [ poundingcore-manual-windows-x64 ] required for [ win32-x64 ].',
        'Available artifacts: poundingcore-manual-macos-arm64, poundingcore-manual-linux-x64.',
        'Re-run poundingcore Manual Build with platform [ windows-x64 ] or all.',
      ].join(' ')
    );
  });
});
