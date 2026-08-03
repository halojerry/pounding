/**
 * Portable (zip-based) auto-updater for USB/dealer deployments.
 *
 * Downloads the new zip from COS, extracts in-place while preserving
 * user data (data/ directory and dealer-config.json), then restarts.
 */

import { app } from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWriteStream } from 'node:fs';

const COS_BASE = 'https://yss-1256275613.cos.ap-guangzhou.myqcloud.com';
const COS_LATEST_YML = `${COS_BASE}/pounding/releases/latest/latest.yml`;

export interface PortableUpdateInfo {
  version: string;
  zipUrl: string;
}

function getExeDir(): string {
  let exeDir = path.dirname(app.getPath('exe'));
  if (process.platform === 'darwin' && exeDir.endsWith('Contents/MacOS')) {
    exeDir = path.dirname(path.dirname(path.dirname(exeDir)));
  }
  return exeDir;
}

export function isPortable(): boolean {
  try {
    return fs.existsSync(path.join(getExeDir(), 'PORTABLE'));
  } catch {
    return false;
  }
}

/** Fetch the latest version info from COS latest.yml. */
export async function fetchPortableUpdate(): Promise<PortableUpdateInfo | null> {
  try {
    const resp = await fetch(COS_LATEST_YML, {
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!resp.ok) return null;
    const yml = await resp.text();

    const versionMatch = yml.match(/^version:\s*(.+)$/m);
    const pathMatch = yml.match(/^path:\s*(.+)$/m);
    if (!versionMatch || !pathMatch) return null;

    const version = versionMatch[1].trim();
    const zipFileName = pathMatch[1].trim();
    // latest/ 为平铺目录：zip 文件名自带版本号（如 POUNDING-2.1.42-win-x64.zip）。
    const zipUrl = `${COS_BASE}/pounding/releases/latest/${zipFileName}`;

    if (version === app.getVersion()) return null;

    return { version, zipUrl };
  } catch {
    return null;
  }
}

/** Download file with progress. */
async function downloadFile(url: string, dest: string, onProgress?: (pct: number) => void): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);
  const total = parseInt(resp.headers.get('content-length') || '0', 10);
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('No response body');

  const file = createWriteStream(dest);
  let downloaded = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      downloaded += value.length;
      file.write(value);
      if (total > 0 && onProgress) onProgress(Math.round((downloaded / total) * 100));
    }
  } finally {
    file.end();
    reader.releaseLock();
  }
}

/** Extract zip using system unzip (macOS/Linux) or PowerShell (Windows). */
function extractZip(zipPath: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ]);
  } else {
    execFileSync('unzip', ['-qo', zipPath, '-d', destDir]);
  }
}

/** Recursive directory copy, skipping protected files. */
function copyDirOverwrite(src: string, dest: string, skipNames: Set<string> = new Set()): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirOverwrite(s, d, skipNames);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * Perform the portable update.
 */
export async function performPortableUpdate(
  updateInfo: PortableUpdateInfo,
  onProgress?: (pct: number) => void
): Promise<void> {
  const exeDir = getExeDir();
  const tmpDir = path.join(os.tmpdir(), `pounding-update-${Date.now()}`);
  const zipPath = path.join(tmpDir, 'update.zip');
  const extractDir = path.join(tmpDir, 'extracted');

  fs.mkdirSync(tmpDir, { recursive: true });

  onProgress?.(10);
  await downloadFile(updateInfo.zipUrl, zipPath);

  onProgress?.(50);
  extractZip(zipPath, extractDir);

  onProgress?.(80);
  const skipNames = new Set(['data', 'dealer-config.json', 'PORTABLE', 'data-location']);

  // Zip usually has one top-level dir (e.g. POUNDING-2.1.5-mac-arm64/)
  const entries = fs.readdirSync(extractDir);
  const appDir =
    entries.length === 1 && fs.statSync(path.join(extractDir, entries[0])).isDirectory()
      ? path.join(extractDir, entries[0])
      : extractDir;

  copyDirOverwrite(appDir, exeDir, skipNames);

  // Restart
  if (process.platform === 'win32') {
    const bat = path.join(exeDir, '_update_restart.bat');
    fs.writeFileSync(
      bat,
      `@echo off\r\n` +
        `timeout /t 2 /nobreak >nul\r\n` +
        `rmdir /s /q "${tmpDir}"\r\n` +
        `start "" "${path.join(exeDir, app.getName() + '.exe')}"\r\n` +
        `del "%~f0"\r\n`
    );
    execFile('cmd', ['/c', bat], { detached: true, cwd: exeDir } as any);
  } else {
    const script = path.join(tmpDir, 'restart.sh');
    fs.writeFileSync(
      script,
      `#!/bin/bash\nsleep 1\nrm -rf "${tmpDir}"\n"${exeDir}/${app.getName()}.app/Contents/MacOS/${app.getName()}" &\n`,
      { mode: 0o755 }
    );
    execFile('/bin/bash', [script], { detached: true } as any);
  }

  onProgress?.(100);
  app.quit();
}
