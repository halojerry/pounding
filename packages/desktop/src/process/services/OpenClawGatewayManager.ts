/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Manages the OpenClaw Gateway lifecycle.
 *
 * The OpenClaw ACP bridge (`openclaw acp`) connects to a Gateway via
 * WebSocket before it completes the stdio ACP initialize handshake.
 * If no gateway is running on ws://127.0.0.1:18789, the bridge fails
 * to connect and the ACP session never starts.
 *
 * This manager auto-starts the gateway daemon on demand and monitors
 * its health.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const GATEWAY_DEFAULT_PORT = 18789;
const GATEWAY_START_TIMEOUT_MS = 15_000;
const GATEWAY_HEALTH_POLL_INTERVAL_MS = 500;
const GATEWAY_MAX_RESTART_ATTEMPTS = 3;
const RESTART_WINDOW_MS = 60_000;

type GatewayStatus = 'stopped' | 'starting' | 'running' | 'failed';

interface GatewayState {
  status: GatewayStatus;
  process: ChildProcess | null;
  port: number;
  restartCount: number;
  restartWindowStart: number;
}

const state: GatewayState = {
  status: 'stopped',
  process: null,
  port: GATEWAY_DEFAULT_PORT,
  restartCount: 0,
  restartWindowStart: 0,
};

/** HTTP health check against the gateway's health endpoint. */
function checkGatewayHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Poll until the gateway responds to health checks. */
async function waitForGatewayReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkGatewayHealth(port)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, GATEWAY_HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

/** Resolve the openclaw binary from PATH. */
function resolveOpenClawBinary(): string {
  try {
    const bunBinDir = path.join(os.homedir(), '.bun', 'bin');
    const bunPath = path.join(bunBinDir, process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw');
    if (fs.existsSync(bunPath)) return bunPath;
  } catch {
    /* fall through */
  }

  try {
    const localBinDir = path.join(os.homedir(), '.local', 'bin');
    const localPath = path.join(localBinDir, process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw');
    if (fs.existsSync(localPath)) return localPath;
  } catch {
    /* fall through */
  }

  return 'openclaw'; // fallback to PATH resolution
}

/** Start the OpenClaw gateway daemon. */
function startGateway(port: number): ChildProcess {
  const binary = resolveOpenClawBinary();
  const openclawHome = path.join(os.homedir(), '.openclaw');

  console.log(`[OpenClawGatewayManager] Starting gateway: ${binary} on port ${port}`);

  const proc = spawn(binary, ['gateway', 'run', '--force'], {
    env: {
      ...process.env,
      OPENCLAW_GATEWAY_PORT: String(port),
      // NOTE: Do NOT set OPENCLAW_HOME. OpenClaw treats it as a home-directory
      // override and appends .openclaw/ → double-nested path → can't find config.
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  proc.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString('utf-8').trim();
    if (lines) {
      console.log(`[OpenClawGateway] ${lines}`);
    }
  });

  proc.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString('utf-8').trim();
    if (lines) {
      console.log(`[OpenClawGateway:stderr] ${lines}`);
    }
  });

  proc.on('exit', (code, signal) => {
    console.log(`[OpenClawGatewayManager] Gateway exited: code=${code} signal=${signal}`);

    if (state.status === 'starting' || state.status === 'running') {
      const now = Date.now();
      if (now - state.restartWindowStart > RESTART_WINDOW_MS) {
        state.restartCount = 0;
        state.restartWindowStart = now;
      }
      state.restartCount++;

      if (state.restartCount <= GATEWAY_MAX_RESTART_ATTEMPTS) {
        console.log(
          `[OpenClawGatewayManager] Auto-restarting gateway (attempt ${state.restartCount}/${GATEWAY_MAX_RESTART_ATTEMPTS})`
        );
        state.process = startGateway(port);
      } else {
        console.error(
          `[OpenClawGatewayManager] Gateway crashed ${state.restartCount} times within ${RESTART_WINDOW_MS}ms. Giving up.`
        );
        state.status = 'failed';
        state.process = null;
      }
    }
  });

  return proc;
}

/**
 * Ensure the OpenClaw Gateway is running. If not, start it and wait
 * for it to become healthy.
 *
 * Safe to call multiple times — subsequent calls are no-ops if the
 * gateway is already running or starting.
 */
export async function ensureOpenClawGatewayRunning(): Promise<void> {
  if (state.status === 'running') {
    // Quick health check to confirm it's still alive
    if (await checkGatewayHealth(state.port)) {
      return;
    }
    console.log('[OpenClawGatewayManager] Gateway health check failed, restarting...');
    state.status = 'stopped';
    state.process = null;
  }

  if (state.status === 'starting') {
    // Wait for the existing start attempt
    if (await waitForGatewayReady(state.port, GATEWAY_START_TIMEOUT_MS)) {
      state.status = 'running';
      return;
    }
  }

  // Check if gateway is already running from outside
  if (await checkGatewayHealth(GATEWAY_DEFAULT_PORT)) {
    state.status = 'running';
    state.port = GATEWAY_DEFAULT_PORT;
    console.log('[OpenClawGatewayManager] Gateway already running');
    return;
  }

  // Start the gateway
  state.status = 'starting';
  state.process = startGateway(GATEWAY_DEFAULT_PORT);

  const ready = await waitForGatewayReady(GATEWAY_DEFAULT_PORT, GATEWAY_START_TIMEOUT_MS);
  if (ready) {
    state.status = 'running';
    console.log('[OpenClawGatewayManager] Gateway ready');
  } else {
    state.status = 'failed';
    console.error('[OpenClawGatewayManager] Gateway failed to start within timeout');
  }
}

/** Stop the gateway daemon. */
export function stopOpenClawGateway(): void {
  if (state.process) {
    state.process.kill('SIGTERM');
    state.process = null;
  }
  state.status = 'stopped';
}

/** Current gateway status (for diagnostics). */
export function getGatewayStatus(): GatewayStatus {
  return state.status;
}
