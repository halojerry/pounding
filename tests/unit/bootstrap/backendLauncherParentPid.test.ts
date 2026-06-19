import { describe, expect, it } from 'vitest';
import { buildSpawnArgs } from '../../../packages/web-host/src/backend-launcher';

describe('buildSpawnArgs parent pid', () => {
  it('does not add --parent-pid (SpawnConfig has no parentPid field)', () => {
    const args = buildSpawnArgs({
      port: 1,
      dbPath: '/d',
      local: false,
      appVersion: '0.0.1',
      isPackaged: true,
    });

    expect(args).not.toContain('--parent-pid');
  });
});
