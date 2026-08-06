import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const {
  getActionsArtifactName,
  getActionsArtifactMissingMessage,
  preparePoundingcore,
} = require('../../../packages/shared-scripts/src/prepare-poundingcore');

const posixFakeToolchainIt = process.platform === 'win32' ? it.skip : it;

function writeFile(filePath: string, contents = 'x') {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function writeExecutable(filePath: string, contents: string) {
  writeFile(filePath, contents);
  chmodSync(filePath, 0o755);
}

function createFakeToolchain(root: string, { curlFails = false } = {}) {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });

  writeExecutable(
    join(binDir, 'curl'),
    curlFails
      ? '#!/usr/bin/env bash\nexit 1\n'
      : `#!/usr/bin/env bash
set -euo pipefail
out=''
while [[ $# -gt 0 ]]; do
  if [[ "$1" == '-o' ]]; then
    shift
    out="$1"
  fi
  shift || true
done
if [[ -z "$out" ]]; then
  printf '{}'
  exit 0
fi
mkdir -p "$(dirname "$out")"
printf 'archive' > "$out"
`
  );
  writeExecutable(join(binDir, 'wget'), '#!/usr/bin/env bash\nexit 1\n');
  writeExecutable(
    join(binDir, 'gh'),
    `#!/usr/bin/env bash
cat <<'JSON'
{"artifacts":[{"id":123,"name":"poundingcore-manual-linux-x64","archive_download_url":"https://example.invalid/artifact.zip"}]}
JSON
`
  );
  writeExecutable(
    join(binDir, 'unzip'),
    `#!/usr/bin/env bash
set -euo pipefail
out=''
while [[ $# -gt 0 ]]; do
  if [[ "$1" == '-d' ]]; then
    shift
    out="$1"
  fi
  shift || true
done
mkdir -p "$out"
printf 'archive' > "$out/poundingcore-v0.1.46-x86_64-unknown-linux-gnu.tar.gz"
`
  );
  writeExecutable(
    join(binDir, 'tar'),
    `#!/usr/bin/env bash
set -euo pipefail
out=''
while [[ $# -gt 0 ]]; do
  if [[ "$1" == '-C' ]]; then
    shift
    out="$1"
  fi
  shift || true
done
mkdir -p "$out"
cat > "$out/poundingcore" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$out/poundingcore"
`
  );

  return binDir;
}

afterEach(() => {
  delete process.env.AIONUI_BACKEND_RUN_ID;
  delete process.env.AIONUI_BACKEND_LOCAL_BINARY;
  rmSync(join(tmpdir(), 'poundingcore-prepare', 'v0.1.46'), { recursive: true, force: true });
  rmSync(join(tmpdir(), 'poundingcore-prepare-actions', '123'), { recursive: true, force: true });
});

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

  // These cases execute a temporary POSIX shell-script aioncore binary. Windows
  // coverage for contract rejection lives in the verifier/local-bundle tests.
  posixFakeToolchainIt('hard fails Actions artifact input when prepared managed resources lack contract', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aionui-actions-gate-'));
    const fakeBin = createFakeToolchain(tmp);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${delimiter}${previousPath || ''}`;
    process.env.AIONUI_BACKEND_RUN_ID = '123';

    try {
      expect(() =>
        preparePoundingcore({
          projectRoot: join(tmp, 'project'),
          platform: 'linux',
          arch: 'x64',
          version: 'v0.1.46',
        })
      ).toThrow(/managed-resources\/manifest\.json/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  posixFakeToolchainIt('hard fails GitHub release download input when prepared managed resources lack contract', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aionui-download-gate-'));
    const fakeBin = createFakeToolchain(tmp);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${delimiter}${previousPath || ''}`;

    try {
      expect(() =>
        preparePoundingcore({
          projectRoot: join(tmp, 'project'),
          platform: 'linux',
          arch: 'x64',
          version: 'v0.1.46',
        })
      ).toThrow(/managed-resources\/manifest\.json/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  posixFakeToolchainIt('hard fails local binary fallback when prepared managed resources lack contract', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aionui-local-binary-gate-'));
    const localBinary = join(tmp, 'poundingcore');
    writeExecutable(localBinary, '#!/usr/bin/env bash\nexit 0\n');
    const fakeBin = createFakeToolchain(tmp, { curlFails: true });
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${delimiter}${previousPath || ''}`;
    process.env.AIONUI_BACKEND_LOCAL_BINARY = localBinary;

    try {
      expect(() =>
        preparePoundingcore({
          projectRoot: join(tmp, 'project'),
          platform: 'linux',
          arch: 'x64',
          version: 'v0.1.46',
        })
      ).toThrow(/managed-resources\/manifest\.json/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
