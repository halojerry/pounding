/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import { runtimeKeyToCliTarget, useCliOnDemandInstall } from '@/renderer/hooks/cli/useCliOnDemandInstall';

vi.mock('@/common/adapter/ipcBridge', () => ({
  managedCliInstaller: {
    install: { invoke: vi.fn() },
  },
}));

const installMock = vi.mocked(ipcBridge.managedCliInstaller.install.invoke);

const Probe: React.FC = () => {
  const { status, target, error, requestInstall, cancel, retry } = useCliOnDemandInstall();
  return (
    <div>
      <span data-testid='status'>{status}</span>
      <span data-testid='target'>{target ?? ''}</span>
      <span data-testid='error'>{error ?? ''}</span>
      <button onClick={() => requestInstall('hermes')}>install</button>
      <button onClick={cancel}>cancel</button>
      <button onClick={retry}>retry</button>
    </div>
  );
};

describe('runtimeKeyToCliTarget', () => {
  it('maps claude/hermes/openclaw and ignores other runtimes', () => {
    expect(runtimeKeyToCliTarget('claude')).toBe('claude');
    expect(runtimeKeyToCliTarget('hermes')).toBe('hermes');
    expect(runtimeKeyToCliTarget('openclaw')).toBe('openclaw');
    expect(runtimeKeyToCliTarget('aionrs')).toBeNull();
    expect(runtimeKeyToCliTarget('')).toBeNull();
    expect(runtimeKeyToCliTarget(null)).toBeNull();
  });
});

describe('useCliOnDemandInstall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('auto-installs the requested CLI and reports done on success', async () => {
    let resolveInstall: (value: { success: boolean; status: string }) => void = () => {};
    const gate = new Promise<{ success: boolean; status: string }>((resolve) => {
      resolveInstall = resolve;
    });
    installMock.mockReturnValue(gate);

    render(<Probe />);
    await userEvent.click(screen.getByText('install'));

    expect(installMock).toHaveBeenCalledWith({ target: 'hermes' });
    expect(screen.getByTestId('status').textContent).toBe('installing');
    resolveInstall({ success: true, status: 'installed' });
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('done'));
  });

  it('reports the error message when install fails', async () => {
    installMock.mockResolvedValue({ success: false, status: 'failed', message: 'pip exploded' });

    render(<Probe />);
    await userEvent.click(screen.getByText('install'));

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('error'));
    expect(screen.getByTestId('error').textContent).toBe('pip exploded');
  });

  it('cancel hides the banner state', async () => {
    let resolveInstall: (value: { success: boolean; status: string }) => void = () => {};
    const gate = new Promise<{ success: boolean; status: string }>((resolve) => {
      resolveInstall = resolve;
    });
    installMock.mockReturnValue(gate);

    render(<Probe />);
    await userEvent.click(screen.getByText('install'));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('installing'));
    await userEvent.click(screen.getByText('cancel'));

    expect(screen.getByTestId('status').textContent).toBe('idle');
    expect(screen.getByTestId('target').textContent).toBe('');
    resolveInstall({ success: true, status: 'installed' });
  });
});
