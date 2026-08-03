/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

/**
 * Boot splash shown while poundingcore is cold-starting. The main window is
 * created before the backend reports ready (so slow machines show immediate
 * feedback instead of appearing frozen), and main.tsx swaps this splash for
 * the real app when `backend:port-updated` arrives.
 *
 * Deliberately self-contained (no i18n/assets): it must render even before the
 * backend/config services are reachable.
 */
const BackendStartingSplash: React.FC = () => (
  <div
    data-testid='backend-starting-splash'
    style={{
      height: '100vh',
      width: '100vw',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 16,
      background: '#ffffff',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    }}
  >
    <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: 2, color: '#1d2129' }}>POUNDING</div>
    <div
      data-testid='backend-starting-spinner'
      style={{
        width: 28,
        height: 28,
        border: '3px solid #e5e6eb',
        borderTopColor: '#4e5969',
        borderRadius: '50%',
        animation: 'pounding-splash-spin 1s linear infinite',
      }}
    />
    <div style={{ fontSize: 14, color: '#86909c' }}>正在启动… / Starting…</div>
    <style>{'@keyframes pounding-splash-spin { to { transform: rotate(360deg); } }'}</style>
  </div>
);

export default BackendStartingSplash;
