/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AssistantHomeTabs from '@/renderer/pages/settings/AssistantSettings/home/AssistantHomeTabs';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue || _key,
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

vi.mock('@/renderer/components/base/TalkToButlerButton', () => ({
  default: () => <button type='button'>create</button>,
}));

vi.mock('@/renderer/components/base', () => ({
  AionSearchInput: () => <input data-testid='search-input' />,
}));

vi.mock('@/renderer/pages/settings/AssistantSettings/home/EnabledAssistantsList', () => ({
  default: () => <div data-testid='enabled-list' />,
}));

vi.mock('@/renderer/pages/settings/AssistantSettings/home/MyAssistantsList', () => ({
  default: () => <div data-testid='mine-list' />,
}));

vi.mock('@/renderer/pages/settings/AssistantSettings/home/OfficialAssistantsGrid', () => ({
  default: () => <div data-testid='official-list' />,
}));

vi.mock('@/renderer/components/settings/RuntimeEnvironmentPanel', () => ({
  default: () => <div data-testid='runtime-env-panel' />,
}));

const noop = (): void => {};

const renderTabs = (initialTab: 'enabled' | 'mine' | 'official' | 'runtime' = 'enabled') =>
  render(
    <AssistantHomeTabs
      assistants={[]}
      assistantOrder={[]}
      localeKey='en-US'
      onOpenDetail={noop}
      onOpenSettings={noop}
      onDuplicate={noop}
      onDelete={noop}
      onCreate={noop}
      onToggleEnabled={noop}
      onReorderEnabled={noop}
      onStartChat={noop}
      initialTab={initialTab}
    />
  );

describe('AssistantHomeTabs — 运行环境 tab', () => {
  it('渲染"运行环境"tab，点击后显示 RuntimeEnvironmentPanel', () => {
    renderTabs();

    expect(screen.getByTestId('enabled-list')).toBeTruthy();
    fireEvent.click(screen.getByText('Runtime Environment'));

    expect(screen.getByTestId('runtime-env-panel')).toBeTruthy();
    expect(screen.queryByTestId('enabled-list')).toBeNull();
  });

  it('initialTab=runtime 时直接渲染运行环境面板', () => {
    renderTabs('runtime');
    expect(screen.getByTestId('runtime-env-panel')).toBeTruthy();
  });
});
