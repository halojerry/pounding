/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

import BackendStartingSplash from '@renderer/components/layout/BackendStartingSplash';

describe('BackendStartingSplash', () => {
  it('renders brand and a starting indicator while waiting for the backend', () => {
    render(<BackendStartingSplash />);
    expect(screen.getByTestId('backend-starting-splash')).toBeTruthy();
    expect(screen.getByText('POUNDING')).toBeTruthy();
    expect(screen.getByTestId('backend-starting-spinner')).toBeTruthy();
  });
});
