import { afterEach, describe, expect, it } from 'vitest';
import {
  assertStartupArchitectureCompatible,
  detectStartupArchitectureMismatch,
  StartupArchitectureMismatchError,
} from '@/process/startup/architectureCompatibility';

const originalAllowRosetta = process.env.POUNDING_ALLOW_ROSETTA;

afterEach(() => {
  if (originalAllowRosetta === undefined) {
    delete process.env.POUNDING_ALLOW_ROSETTA;
  } else {
    process.env.POUNDING_ALLOW_ROSETTA = originalAllowRosetta;
  }
});

/** sysctl 结果按 name 返回 0/1。 */
function sysctlStub(values: Record<string, string>) {
  return (command: string, _args: string[], _options: unknown): string => {
    for (const [name, value] of Object.entries(values)) {
      if (command === 'sysctl' && _args.includes('-in') && _args.includes(name)) {
        return `${value}\n`;
      }
    }
    throw new Error(`unexpected sysctl call: ${command} ${String(_args)}`);
  };
}

describe('detectStartupArchitectureMismatch', () => {
  it('returns null for non-macOS / dev mode / arm64 package', () => {
    expect(detectStartupArchitectureMismatch({ platform: 'win32', isPackaged: true, arch: 'x64' })).toBeNull();
    expect(detectStartupArchitectureMismatch({ platform: 'darwin', isPackaged: false, arch: 'x64' })).toBeNull();
    expect(detectStartupArchitectureMismatch({ platform: 'darwin', isPackaged: true, arch: 'arm64' })).toBeNull();
  });

  it('returns null on Intel Macs (no Rosetta translation, no arm64 hardware)', () => {
    const result = detectStartupArchitectureMismatch({
      platform: 'darwin',
      isPackaged: true,
      arch: 'x64',
      execFileSync: sysctlStub({
        'sysctl.proc_translated': '0',
        'hw.optional.arm64': '0',
      }),
    });
    expect(result).toBeNull();
  });

  it('flags x64 package running under Rosetta on Apple Silicon', () => {
    const result = detectStartupArchitectureMismatch({
      platform: 'darwin',
      isPackaged: true,
      arch: 'x64',
      execFileSync: sysctlStub({
        'sysctl.proc_translated': '1',
        'hw.optional.arm64': '1',
      }),
    });
    expect(result).toMatchObject({
      deviceArch: 'arm64',
      packageArch: 'x64',
      isRosettaTranslated: true,
      stage: 'startup_architecture_check',
    });
  });

  it('skips the mismatch when allowRosetta is set (CI OOB gate)', () => {
    const result = detectStartupArchitectureMismatch({
      platform: 'darwin',
      isPackaged: true,
      arch: 'x64',
      allowRosetta: true,
      execFileSync: sysctlStub({
        'sysctl.proc_translated': '1',
        'hw.optional.arm64': '1',
      }),
    });
    expect(result).toBeNull();
  });

  it('skips the mismatch when POUNDING_ALLOW_ROSETTA=1 is set', () => {
    process.env.POUNDING_ALLOW_ROSETTA = '1';
    const result = detectStartupArchitectureMismatch({
      platform: 'darwin',
      isPackaged: true,
      arch: 'x64',
      execFileSync: sysctlStub({
        'sysctl.proc_translated': '1',
        'hw.optional.arm64': '1',
      }),
    });
    expect(result).toBeNull();
  });

  it('assertStartupArchitectureCompatible throws only without the bypass', () => {
    expect(() =>
      assertStartupArchitectureCompatible({
        platform: 'darwin',
        isPackaged: true,
        arch: 'x64',
        execFileSync: sysctlStub({
          'sysctl.proc_translated': '1',
          'hw.optional.arm64': '1',
        }),
      })
    ).toThrow(StartupArchitectureMismatchError);

    expect(() =>
      assertStartupArchitectureCompatible({
        platform: 'darwin',
        isPackaged: true,
        arch: 'x64',
        allowRosetta: true,
        execFileSync: sysctlStub({
          'sysctl.proc_translated': '1',
          'hw.optional.arm64': '1',
        }),
      })
    ).not.toThrow();
  });
});
