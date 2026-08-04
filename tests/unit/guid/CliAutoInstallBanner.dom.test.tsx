/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CliAutoInstallBanner from '@/renderer/pages/guid/components/CliAutoInstallBanner';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue || _key,
  }),
}));

describe('CliAutoInstallBanner', () => {
  it('renders nothing when idle or no target', () => {
    const { container } = render(
      <CliAutoInstallBanner status='idle' target={null} onCancel={vi.fn()} onRetry={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows installing state with cancel', () => {
    const onCancel = vi.fn();
    render(<CliAutoInstallBanner status='installing' target='hermes' onCancel={onCancel} onRetry={vi.fn()} />);

    expect(screen.getByTestId('cli-auto-install-banner')).toBeTruthy();
    expect(screen.getByText('Installing runtime environment…')).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows retry on error', () => {
    const onRetry = vi.fn();
    render(<CliAutoInstallBanner status='error' error='boom' target='openclaw' onCancel={vi.fn()} onRetry={onRetry} />);

    expect(screen.getByText('Failed to install runtime')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
    fireEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows ready state on done', () => {
    render(<CliAutoInstallBanner status='done' target='claude' onCancel={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText('Runtime environment ready')).toBeTruthy();
  });
});
