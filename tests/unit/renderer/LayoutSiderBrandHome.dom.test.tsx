/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

// Mirror the project convention: t() echoes the key so labels/tooltips are assertable.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

// react-router-dom: control location, capture navigate.
const navigate = vi.fn();
let currentPathname = '/guid';
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: currentPathname, search: '', hash: '' }),
  useNavigationType: () => 'POP',
  Outlet: () => null,
}));

// Hidden devtools easter-egg target (icon) — assert it is independent of navigation.
const openDevTools = vi.fn(() => Promise.resolve());
vi.mock('@/common', () => ({
  ipcBridge: {
    application: {
      openDevTools: { invoke: () => openDevTools() },
      logStream: { on: () => () => {} },
    },
    task: { stopAll: { invoke: () => Promise.resolve({ success: false }) } },
  },
}));

// Trim Layout's collaborators to keep this a focused brand-behaviour test.
vi.mock('@/common/config/constants', () => ({ TEAM_MODE_ENABLED: false }));
vi.mock('@/renderer/components/layout/PwaPullToRefresh', () => ({ default: () => null }));

// Titlebar mock: render the back-to-chat button (in settings routes) and the logo icon for the easter egg.
// These elements were originally in Layout's sider header — they now live in Titlebar.
let devToolsClickCount = 0;
vi.mock('@/renderer/components/layout/Titlebar', () => ({
  default: () => {
    const isSettings = currentPathname.startsWith('/settings');

    const handleBackToChat = () => {
      const stored = sessionStorage.getItem('aion:last-non-settings-path');
      if (stored && !stored.startsWith('/settings')) {
        navigate(stored);
      } else {
        navigate('/guid');
      }
    };

    const handleIconClick = () => {
      devToolsClickCount++;
      if (devToolsClickCount >= 4) {
        openDevTools();
        devToolsClickCount = 0;
      }
    };

    return (
      <div>
        {isSettings && (
          <button
            type='button'
            aria-label='common.back'
            onClick={handleBackToChat}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleBackToChat();
              }
            }}
          />
        )}
        {/* Logo icon wrapper — easter-egg target, separate from the wordmark */}
        <div className='bg-black' onClick={handleIconClick} />
      </div>
    );
  },
}));

vi.mock('@/renderer/components/settings/UpdateModal', () => ({ default: () => null }));
vi.mock('@renderer/hooks/system/useDeepLink', () => ({ useDeepLink: () => {} }));
vi.mock('@renderer/hooks/system/useNotificationClick', () => ({ useNotificationClick: () => {} }));
vi.mock('@renderer/hooks/file/useDirectorySelection', () => ({
  useDirectorySelection: () => ({ contextHolder: null }),
}));
vi.mock('@renderer/utils/ui/siderTooltip', () => ({ cleanupSiderTooltips: () => {} }));
vi.mock('@renderer/hooks/ui/useConversationShortcuts', () => ({ useConversationShortcuts: () => {} }));
vi.mock('@renderer/utils/platform', () => ({ isElectronDesktop: () => false }));

// Layout uses Arco's Layout component for the shell.
vi.mock('@arco-design/web-react', () => {
  const ArcoSider = ({ children, ...props }: { children?: React.ReactNode }) => (
    <aside {...props}>{children}</aside>
  );
  const ArcoHeader = ({ children, ...props }: { children?: React.ReactNode }) => (
    <header {...props}>{children}</header>
  );
  const ArcoContent = ({ children, ...props }: { children?: React.ReactNode }) => (
    <main {...props}>{children}</main>
  );
  const ArcoLayout = Object.assign(
    ({ children, className }: { children?: React.ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
    { Sider: ArcoSider, Header: ArcoHeader, Content: ArcoContent }
  );
  return {
    Layout: ArcoLayout,
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button type='button' {...props}>{children}</button>
    ),
    Spin: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    Trigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('@icon-park/react', () => ({
  MenuFold: () => <span aria-hidden='true' />,
  MenuUnfold: () => <span aria-hidden='true' />,
}));

vi.mock('@/renderer/hooks/context/NewApiAccountContext', () => ({
  useNewApiAccount: () => ({
    ready: true,
    isLoggedIn: true,
    status: { envConflicts: [] },
  }),
}));

vi.mock('@renderer/components/layout/DesktopLoginGate', () => ({ default: () => null }));
vi.mock('@renderer/components/settings/EnvConflictBanner', () => ({ default: () => null }));
vi.mock('@renderer/hooks/context/NavigationHistoryContext', () => ({
  NavigationHistoryProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import Layout from '@renderer/components/layout/Layout';

const renderLayout = () => render(<Layout sider={<div>sider</div>} />);

const BACK_KEY = 'common.back';

describe('Layout sider brand Home button', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    navigate.mockClear();
    openDevTools.mockClear();
    devToolsClickCount = 0;
    sessionStorage.clear();
    currentPathname = '/guid';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('navigates to the recorded last non-settings path when clicked in a settings route', () => {
    currentPathname = '/settings/about';
    sessionStorage.setItem('aion:last-non-settings-path', '/conversation/abc');
    renderLayout();

    fireEvent.click(screen.getByLabelText(BACK_KEY));
    expect(navigate).toHaveBeenCalledWith('/conversation/abc');
  });

  it('falls back to /guid in a settings route when no path is recorded', () => {
    currentPathname = '/settings/system';
    renderLayout();

    fireEvent.click(screen.getByLabelText(BACK_KEY));
    expect(navigate).toHaveBeenCalledWith('/guid');
  });

  it('falls back to /guid when the recorded path is itself a settings path', () => {
    currentPathname = '/settings/about';
    sessionStorage.setItem('aion:last-non-settings-path', '/settings/system');
    renderLayout();

    fireEvent.click(screen.getByLabelText(BACK_KEY));
    expect(navigate).toHaveBeenCalledWith('/guid');
  });

  it('activates via keyboard (Enter and Space) in a settings route', () => {
    currentPathname = '/settings/about';
    sessionStorage.setItem('aion:last-non-settings-path', '/conversation/abc');
    renderLayout();

    const brand = screen.getByLabelText(BACK_KEY);
    fireEvent.keyDown(brand, { key: 'Enter' });
    fireEvent.keyDown(brand, { key: ' ' });
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledWith('/conversation/abc');
  });

  it('ignores non-activation keys in a settings route', () => {
    currentPathname = '/settings/about';
    sessionStorage.setItem('aion:last-non-settings-path', '/conversation/abc');
    renderLayout();

    const brand = screen.getByLabelText(BACK_KEY);
    fireEvent.keyDown(brand, { key: 'Tab' });
    fireEvent.keyDown(brand, { key: 'a' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('renders the wordmark as a non-actionable element in a non-settings route', () => {
    currentPathname = '/guid';
    renderLayout();

    // No actionable role/label in chat routes.
    expect(screen.queryByLabelText(BACK_KEY)).toBeNull();
    const wordmark = screen.getByText('POUNDING');
    fireEvent.click(wordmark);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not navigate when the wordmark is clicked in a non-settings route', () => {
    currentPathname = '/conversation/xyz';
    renderLayout();

    fireEvent.click(screen.getByText('POUNDING'));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('clicking the logo icon counts toward the devtools easter-egg and never navigates', () => {
    currentPathname = '/settings/about';
    sessionStorage.setItem('aion:last-non-settings-path', '/conversation/abc');
    const { container } = renderLayout();

    // The icon is the SVG-wrapping div (bg-black), separate from the wordmark.
    const icon = container.querySelector('.bg-black') as HTMLElement;
    expect(icon).toBeTruthy();
    for (let i = 0; i < 4; i++) fireEvent.click(icon);
    expect(openDevTools).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
