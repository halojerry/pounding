/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Desktop NewApi account service — login chain only.
 *
 * Handles: login to the POUNDING API (api.mxou.cn), token resolution,
 * managed provider upsert (so aionrs conversations can use the account),
 * and status persistence to the backend `/api/settings/managed-runtime`
 * route (with `/api/settings/client` fallback for older backends).
 *
 * Explicitly out of scope (deferred to a later iteration): CLI config
 * file sync (claude/hermes/opencode/openclaw), CC-Switch DB, and the
 * managed-CLI install/verify surface. This keeps the login chain
 * self-contained on the clean upstream baseline.
 */

import { httpRequest, isBackendHttpError } from '@/common/adapter/httpBridge';
import type { IProvider } from '@/common/config/storage';
import type {
  NewApiAccountStatus,
  NewApiDesktopUser,
  NewApiLoginParams,
  NewApiLoginResponse,
  NewApiSubscription,
  NewApiUserPayload,
} from '@/common/types/newApiAccount';
import type { CreateProviderRequest, UpdateProviderRequest } from '@/common/types/provider/providerApi';
import { ProcessConfig } from '@process/utils/initStorage';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NEW_API_BASE_URL = 'https://api.mxou.cn';
const POUNDING_CONFIG_PATH = path.join(os.homedir(), '.pounding', 'config.json');
const NEW_API_STORAGE_KEY = 'newApi.desktop.account';
const NEW_API_MANAGED_PROVIDER_ID = 'desktop-newapi-managed-provider';
const NEW_API_PROVIDER_DISPLAY_NAME = 'POUNDING API';

type BridgeResponse<D = {}> = {
  success: boolean;
  data?: D;
  msg?: string;
};

type NewApiResponse<T> = {
  success?: boolean;
  message?: string;
  msg?: string;
  data?: T;
  token?: string;
  access_token?: string;
  accessToken?: string;
  key?: string;
  value?: string;
  username?: string;
  user_name?: string;
  quota?: number;
  usedQuota?: number;
  used_quota?: number;
};

type FetchResult<T> = {
  data: T;
  cookies: string[];
};

type NewApiRequestOptions = {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  cookies?: string[];
  token?: string;
  userId?: string;
};

type NewApiChannelConnection = {
  _type?: string;
  key?: string;
  url?: string;
};

type ResolvedManagedToken = {
  token: string;
  baseUrl: string;
};

type ManagedRuntimeStateResponse = {
  account?: {
    logged_in?: boolean;
    base_url?: string;
    models?: string[];
    updated_at?: number;
    user?: {
      id?: string | number;
      username?: string;
      display_name?: string;
      email?: string;
      quota?: number;
      used_quota?: number;
      avatar_letter?: string;
    };
    managed_provider_id?: string;
  };
};

const EMPTY_STATUS: NewApiAccountStatus = {
  loggedIn: false,
  baseUrl: NEW_API_BASE_URL,
  models: [],
  updatedAt: 0,
};

// ── Status persistence (backend managed-runtime + local client settings) ──

function toPersistedAccountStatus(status: NewApiAccountStatus): NewApiAccountStatus {
  return {
    loggedIn: status.loggedIn,
    baseUrl: status.baseUrl,
    models: [...status.models],
    updatedAt: status.updatedAt,
    user: status.user ? { ...status.user } : undefined,
    token: status.token,
    cookies: status.cookies,
    managedProviderId: status.managedProviderId,
  };
}

function toBackendManagedRuntimeAccount(status: NewApiAccountStatus) {
  return {
    logged_in: status.loggedIn,
    base_url: status.baseUrl,
    models: [...status.models],
    updated_at: status.updatedAt,
    user: status.user
      ? {
          id: status.user.id,
          username: status.user.username,
          display_name: status.user.displayName,
          email: status.user.email,
          quota: status.user.quota,
          used_quota: status.user.usedQuota,
          avatar_letter: status.user.avatarLetter,
        }
      : undefined,
    managed_provider_id: status.managedProviderId,
  };
}

function fromManagedRuntimeAccountStatus(
  account: ManagedRuntimeStateResponse['account']
): NewApiAccountStatus | undefined {
  if (!account) return undefined;
  const username = account.user?.username?.trim();
  const user: NewApiDesktopUser | undefined = username
    ? {
        id: account.user?.id != null ? String(account.user.id) : undefined,
        username,
        displayName: account.user?.display_name?.trim() || undefined,
        email: account.user?.email?.trim() || undefined,
        quota: typeof account.user?.quota === 'number' ? account.user.quota : undefined,
        usedQuota: typeof account.user?.used_quota === 'number' ? account.user.used_quota : undefined,
        avatarLetter: account.user?.avatar_letter?.trim() || undefined,
      }
    : undefined;

  return {
    loggedIn: Boolean(account.logged_in),
    baseUrl: isNonEmptyString(account.base_url) ? account.base_url : NEW_API_BASE_URL,
    models: Array.isArray(account.models) ? account.models.filter(isNonEmptyString) : [],
    updatedAt: typeof account.updated_at === 'number' ? account.updated_at : 0,
    user,
    managedProviderId: isNonEmptyString(account.managed_provider_id) ? account.managed_provider_id : undefined,
  };
}

function mergeAccountStatus(
  persisted: NewApiAccountStatus | undefined,
  local: NewApiAccountStatus | undefined
): NewApiAccountStatus {
  const base = persisted ?? local ?? EMPTY_STATUS;
  return {
    ...base,
    user: base.user ? { ...base.user } : undefined,
    models: [...(base.models ?? [])],
    token: local?.token?.trim() || undefined,
    cookies: local?.cookies ? [...local.cookies] : undefined,
  };
}

function shouldSelfHealManagedRuntimeStatus(status: NewApiAccountStatus): boolean {
  return !status.loggedIn || status.models.length === 0 || !status.managedProviderId;
}

function shouldFallbackToLegacyClientSettings(error: unknown): boolean {
  return isBackendHttpError(error) && [404, 405, 501].includes(error.status);
}

// ── Small value helpers ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeCookies(values: string[] | undefined): string[] {
  if (!values?.length) return [];
  return Array.from(new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0)));
}

function buildCookieHeader(cookies: string[] | undefined): string | undefined {
  if (!cookies?.length) return undefined;
  return cookies.join('; ');
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function extractMessage(data: unknown, fallback: string): string {
  if (!isRecord(data)) return fallback;
  return isNonEmptyString(data.message) ? data.message : isNonEmptyString(data.msg) ? data.msg : fallback;
}

function extractToken(payload: unknown): string | undefined {
  if (payload == null) return undefined;
  if (typeof payload === 'string' && payload.trim()) return payload.trim();
  if (!isRecord(payload)) return undefined;
  const candidates = [payload.token, payload.access_token, payload.accessToken, payload.key, payload.value];
  const direct = candidates.find((c): c is string => typeof c === 'string' && c.length > 0);
  if (direct) return direct;
  // Recursion into `data` mirrors the proven pre-branding implementation:
  // some responses nest the token under data (e.g. { data: { token } }).
  if (payload.data) return extractToken(payload.data);
  return undefined;
}

function isMaskedToken(token: string): boolean {
  const t = token.trim().toLowerCase();
  return t.includes('***') || t.includes('****') || t.includes('...');
}

function extractUserId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const candidates = [payload.sub, payload.user_id, payload.userId, payload.id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  }
  return undefined;
}

function normalizeUser(payload: unknown, usernameFallback: string): NewApiDesktopUser {
  const record = (payload && typeof payload === 'object' ? payload : {}) as NewApiUserPayload;
  const username = record.username || record.user_name || record.displayName || record.name || usernameFallback;
  const usedQuota = record.usedQuota ?? record.used_quota ?? 0;
  const quota = record.quota ?? 520;
  const unlimitedQuota = record.remain_quota === -1 || record.unlimited_quota === true || quota > 1_000_000_000_000;
  const id = record.id != null ? String(record.id) : record.sub ? String(record.sub) : undefined;
  return {
    id,
    username,
    displayName: record.display_name || record.displayName || undefined,
    email: record.email,
    quota,
    usedQuota,
    unlimitedQuota,
    avatarLetter: (username || '?').trim().charAt(0).toUpperCase(),
  };
}

function normalizeModelList(payload: unknown): string[] {
  const data = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const models = Array.isArray(data.data)
    ? data.data
    : Array.isArray(data.models)
      ? data.models
      : Array.isArray(payload)
        ? payload
        : [];
  return Array.from(
    new Set(
      models
        .map((m) =>
          typeof m === 'string' ? m : m && typeof m === 'object' ? (m as Record<string, unknown>).id : undefined
        )
        .filter((m): m is string => isNonEmptyString(m))
    )
  );
}

function getSetCookieValues(response: Response): string[] {
  const anyResponse = response as Response & {
    headers: Headers & { getSetCookie?: () => string[]; raw?: () => Record<string, string[]> };
  };
  const getSetCookie = anyResponse.headers.getSetCookie?.();
  if (Array.isArray(getSetCookie) && getSetCookie.length > 0) return getSetCookie;
  const rawSetCookie = anyResponse.headers.raw?.()['set-cookie'];
  if (Array.isArray(rawSetCookie) && rawSetCookie.length > 0) return rawSetCookie;
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

function extractFirstTokenEntry(payload: unknown): Record<string, unknown> | undefined {
  const data = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const raw = data.data ?? data;
  if (Array.isArray(raw) && raw.length > 0 && isRecord(raw[0])) return raw[0];
  if (isRecord(raw)) {
    const candidates = Object.values(raw).filter((v) => isRecord(v) && ('key' in v || '_type' in v || 'url' in v));
    if (candidates.length > 0) return candidates[0] as Record<string, unknown>;
  }
  return undefined;
}

function extractChannelConnection(payload: unknown): NewApiChannelConnection | undefined {
  if (!isRecord(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  return {
    _type: isNonEmptyString(record._type) ? record._type : undefined,
    key: isNonEmptyString(record.key) ? record.key : undefined,
    url: isNonEmptyString(record.url) ? record.url : undefined,
  };
}

// ── NewAPI HTTP client ──

const FETCH_TIMEOUT_MS = 30_000;
const FETCH_MAX_RETRIES = 2;
const RETRYABLE_ERROR_PATTERNS = [/fetch failed/i, /network/i, /ECONNREFUSED/i, /ETIMEDOUT/i, /ENOTFOUND/i, /timeout/i];

function isRetryableError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  const message = error instanceof Error ? error.message : String(error);
  return RETRYABLE_ERROR_PATTERNS.some((p) => p.test(message));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson<T>(requestPath: string, options: NewApiRequestOptions = {}): Promise<FetchResult<T>> {
  const headers: Record<string, string> = {};
  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }
  const cookieHeader = buildCookieHeader(options.cookies);
  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.userId?.trim()) {
    headers['New-Api-User'] = options.userId.trim();
  }

  const url = `${normalizeBaseUrl(NEW_API_BASE_URL)}${requestPath}`;
  const fetchInit: RequestInit = {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= FETCH_MAX_RETRIES; attempt++) {
    try {
      // oxlint-disable-next-line no-await-in-loop
      const response = await fetchWithTimeout(url, fetchInit, FETCH_TIMEOUT_MS);

      const cookies = normalizeCookies(getSetCookieValues(response));

      if (response.status === 429) {
        console.warn('[POUNDING] fetchJson: rate limited by NewAPI, request:', requestPath);
        throw new Error('Rate limited by NewAPI — too many requests. Please wait and try again.');
      }

      let content: T;
      try {
        // oxlint-disable-next-line no-await-in-loop
        content = (await response.json()) as T;
      } catch (jsonError) {
        // oxlint-disable-next-line no-await-in-loop
        const text = await response.text().catch(() => '<unreadable>');
        console.error('[POUNDING] fetchJson: failed to parse JSON response', {
          url: requestPath,
          status: response.status,
          contentType: response.headers.get('content-type'),
          bodyPreview: text.slice(0, 500),
          error: jsonError instanceof Error ? jsonError.message : String(jsonError),
        });
        content = {} as T;
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          console.error(`[POUNDING] fetchJson: ${response.status} on ${requestPath} — check login/token chain`);
        }
        throw new Error(extractMessage(content, `Request failed with status ${response.status}`));
      }
      // new-api style business failure: HTTP 200 but { success: false, message }.
      // fetchJson would otherwise treat it as success and callers would fail
      // confusingly later (e.g. "Failed to get access token from NewAPI").
      if (isRecord(content) && content.success === false) {
        const businessMsg =
          typeof content.message === 'string' && content.message.trim()
            ? content.message
            : 'Request rejected by NewAPI';
        console.error(`[POUNDING] fetchJson: business error on ${requestPath}: ${businessMsg}`);
        throw new Error(businessMsg);
      }

      return { data: content, cookies };
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_MAX_RETRIES && isRetryableError(error)) {
        const delayMs = (attempt + 1) * 1000;
        console.warn(
          `[POUNDING] fetchJson: retrying after ${delayMs}ms (attempt ${attempt + 1}/${FETCH_MAX_RETRIES}) for ${requestPath}:`,
          error instanceof Error ? error.message : String(error)
        );
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

// ── Token resolution ──

async function fetchFullTokenKey(
  tokenId: string | number,
  cookies: string[],
  loginToken: string | undefined,
  userId: string
): Promise<string | undefined> {
  const tokenKeyResult = await fetchJson<NewApiResponse<{ key?: string }>>(`/api/token/${tokenId}/key`, {
    method: 'POST',
    cookies,
    token: loginToken,
    userId,
  });
  return extractToken(tokenKeyResult.data?.data) ?? extractToken(tokenKeyResult.data);
}

async function resolveManagedToken(
  cookies: string[],
  loginToken: string | undefined,
  userId: string
): Promise<ResolvedManagedToken> {
  const tokenListResult = await fetchJson<NewApiResponse<unknown>>('/api/token/', {
    cookies,
    token: loginToken,
    userId,
  });
  const existingTokenEntry = extractFirstTokenEntry(tokenListResult.data);
  const existingChannelConnection = extractChannelConnection(existingTokenEntry);
  const existingTokenId =
    existingTokenEntry && (typeof existingTokenEntry.id === 'string' || typeof existingTokenEntry.id === 'number')
      ? existingTokenEntry.id
      : undefined;
  const existingToken = existingTokenId
    ? await fetchFullTokenKey(existingTokenId, cookies, loginToken, userId)
    : undefined;

  // Guard: never use a masked key. The token list endpoint may return
  // masked keys (sk-***abcd) and the channel-connection fallback can
  // pick them up. When fetchFullTokenKey succeeds, the key is unmasked.
  if (existingToken && !isMaskedToken(existingToken)) {
    return {
      token: existingToken,
      baseUrl: normalizeBaseUrl(existingChannelConnection?.url || NEW_API_BASE_URL),
    };
  }

  // Existing token is masked or unavailable — create a new one.
  const tokenResult = await fetchJson<NewApiResponse<unknown>>('/api/token/', {
    method: 'POST',
    cookies,
    token: loginToken,
    userId,
    body: { name: 'POUNDING Desktop', unlimited_quota: true },
  });
  const generatedChannelConnection = extractChannelConnection(tokenResult.data);
  const generatedToken =
    extractToken(generatedChannelConnection) ?? extractToken(tokenResult.data) ?? extractToken(tokenResult.data?.data);

  if (!generatedToken) {
    throw new Error('Failed to get access token from NewAPI');
  }

  return {
    token: generatedToken,
    baseUrl: normalizeBaseUrl(generatedChannelConnection?.url || NEW_API_BASE_URL),
  };
}

// ── Backend managed provider upsert ──

function detectNewApiProtocol(modelName: string): string {
  const name = modelName.toLowerCase();
  if (name.startsWith('claude') || name.startsWith('anthropic')) return 'anthropic';
  if (name.startsWith('gemini') || name.startsWith('models/gemini')) return 'gemini';
  return 'openai';
}

function buildManagedProviderPayload(params: {
  apiKey: string;
  models: string[];
  baseUrl?: string;
}): CreateProviderRequest {
  // Append /v1 to the base URL so the aionrs backend constructs
  // the correct API path: {base_url}/chat/completions
  const rawBaseUrl = params.baseUrl || NEW_API_BASE_URL;
  const baseUrl = rawBaseUrl.replace(/\/+$/, '') + '/v1';
  return {
    id: NEW_API_MANAGED_PROVIDER_ID,
    name: NEW_API_PROVIDER_DISPLAY_NAME,
    platform: 'new-api',
    base_url: baseUrl,
    api_key: params.apiKey,
    models: params.models,
    enabled: true,
    model_enabled: Object.fromEntries(params.models.map((model) => [model, true])),
    model_protocols: Object.fromEntries(params.models.map((model) => [model, detectNewApiProtocol(model)])),
  };
}

async function findManagedProvider(): Promise<IProvider | null> {
  const providers = (await httpRequest<IProvider[]>('GET', '/api/providers')) || [];
  return providers.find((provider) => provider.id === NEW_API_MANAGED_PROVIDER_ID) || null;
}

async function upsertManagedProvider(params: {
  apiKey: string;
  models: string[];
  baseUrl?: string;
}): Promise<IProvider> {
  const existing = await findManagedProvider();
  const payload = buildManagedProviderPayload(params);
  if (existing) {
    return await httpRequest<IProvider>(
      'PUT',
      `/api/providers/${NEW_API_MANAGED_PROVIDER_ID}`,
      payload as UpdateProviderRequest
    );
  }
  return await httpRequest<IProvider>('POST', '/api/providers', payload);
}

async function removeManagedProvider(): Promise<void> {
  try {
    const existing = await findManagedProvider();
    if (!existing) return;
    await httpRequest<void>('DELETE', `/api/providers/${NEW_API_MANAGED_PROVIDER_ID}`);
  } catch {
    // API may reject (token expired / 401) — still clear local state below
  }
  // Force-clear the backend provider by re-creating as empty
  try {
    await httpRequest<void>('PUT', `/api/providers/${NEW_API_MANAGED_PROVIDER_ID}`, {
      id: NEW_API_MANAGED_PROVIDER_ID,
      platform: 'new-api',
      name: 'POUNDING API',
      base_url: '',
      api_key: '',
      models: [],
      enabled: false,
    }).catch(() => {});
  } catch {
    /* best-effort */
  }
}

// ── ~/.pounding/config.json (skills read the API key from here) ──

function writePoundingConfig(apiKey: string, baseUrl?: string): void {
  // Guard: never write a masked key to config.json. Skills read this file
  // and need the full API key to call LLM endpoints.
  if (isMaskedToken(apiKey)) {
    console.error('[POUNDING] Refusing to write masked API key to config.json');
    return;
  }
  const config = {
    api: {
      base_url: baseUrl || NEW_API_BASE_URL,
      key: apiKey,
    },
  };
  try {
    fs.mkdirSync(path.dirname(POUNDING_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(POUNDING_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.error('[POUNDING] Failed to write config.json:', err);
  }
}

function clearPoundingConfig(): void {
  try {
    if (fs.existsSync(POUNDING_CONFIG_PATH)) {
      fs.rmSync(POUNDING_CONFIG_PATH, { force: true });
    }
  } catch (err) {
    console.error('[POUNDING] Failed to clear config.json:', err);
  }
}

// ── Status persistence ──

async function getManagedRuntimeState(): Promise<ManagedRuntimeStateResponse | null> {
  try {
    return ((await httpRequest<ManagedRuntimeStateResponse>('GET', '/api/settings/managed-runtime')) ??
      null) as ManagedRuntimeStateResponse | null;
  } catch (error) {
    if (shouldFallbackToLegacyClientSettings(error)) return null;
    throw error;
  }
}

async function getBackendClientSettings(): Promise<Record<string, unknown>> {
  return ((await httpRequest<Record<string, unknown>>('GET', '/api/settings/client')) ?? {}) as Record<string, unknown>;
}

async function getStoredStatus(): Promise<NewApiAccountStatus> {
  const managedRuntime = await getManagedRuntimeState();
  const shouldUseLegacyClientSettings = !managedRuntime || managedRuntime.account == null;
  const backendSettings = shouldUseLegacyClientSettings
    ? await getBackendClientSettings().catch((): Record<string, unknown> => ({}))
    : {};
  const persisted = managedRuntime?.account
    ? fromManagedRuntimeAccountStatus(managedRuntime.account)
    : (backendSettings[NEW_API_STORAGE_KEY] as NewApiAccountStatus | undefined);
  const local = (await ProcessConfig.get(NEW_API_STORAGE_KEY)) as NewApiAccountStatus | undefined;
  return mergeAccountStatus(persisted, local);
}

async function saveStatus(status: NewApiAccountStatus): Promise<void> {
  await ProcessConfig.set(NEW_API_STORAGE_KEY, status);
  try {
    await httpRequest<void>('PUT', '/api/settings/managed-runtime', {
      account: toBackendManagedRuntimeAccount(status),
    });
  } catch (error) {
    if (!shouldFallbackToLegacyClientSettings(error)) throw error;
    await httpRequest<void>('PUT', '/api/settings/client', {
      [NEW_API_STORAGE_KEY]: toPersistedAccountStatus(status),
    });
  }
}

async function clearPersistedStatus(): Promise<void> {
  try {
    await httpRequest<void>('PUT', '/api/settings/managed-runtime', {
      account: null,
    });
  } catch (error) {
    if (!shouldFallbackToLegacyClientSettings(error)) throw error;
    await httpRequest<void>('PUT', '/api/settings/client', {
      [NEW_API_STORAGE_KEY]: null,
    });
  }
}

// ── Service ──

export class NewApiDesktopAccountService {
  async getStatus(): Promise<BridgeResponse<NewApiAccountStatus>> {
    let status = await getStoredStatus();
    if (shouldSelfHealManagedRuntimeStatus(status)) {
      try {
        // Self-heal: if the backend DB was reset but the local (or persisted)
        // login state survives, re-upsert the managed provider so aionrs
        // conversations keep working.
        if (status.loggedIn && status.token && status.models.length > 0) {
          const provider = await findManagedProvider();
          if (!provider) {
            console.warn('[POUNDING] Managed provider missing from backend DB — restoring on getStatus');
            await upsertManagedProvider({
              apiKey: status.token,
              models: status.models,
              baseUrl: status.baseUrl,
            });
          }
        }
      } catch (error) {
        console.warn('[POUNDING] Failed to self-heal managed provider on getStatus:', error);
      }
    }

    return {
      success: true,
      data: status,
    };
  }

  async refreshStatus(): Promise<BridgeResponse<NewApiAccountStatus>> {
    const status = await getStoredStatus();
    if (!status.loggedIn || !status.cookies?.length) {
      return { success: true, data: status };
    }
    try {
      const selfResult = await fetchJson<NewApiResponse<unknown>>('/api/user/self', {
        cookies: status.cookies,
        userId: String(status.user?.id ?? ''),
      });
      const updatedUser = normalizeUser(selfResult.data?.data ?? selfResult.data, status.user?.username ?? '');

      // Fetch subscription info (non-fatal — if it fails, balance card still works)
      try {
        const subResult = await fetchJson<NewApiResponse<unknown>>('/api/user/subscription/self', {
          cookies: status.cookies,
          userId: String(status.user?.id ?? ''),
        });
        const subPayload = (subResult.data?.data ?? subResult.data ?? null) as Record<string, unknown> | null;
        if (subPayload?.subscription || subPayload?.subscriptions) {
          const subs = (
            Array.isArray(subPayload.subscriptions) ? subPayload.subscriptions : [subPayload.subscription ?? subPayload]
          ).filter(Boolean);
          if (subs.length > 0) {
            updatedUser.subscription = subs[0] as NewApiSubscription;
          }
        }
      } catch {
        // Non-fatal: balance card works without subscription
      }

      const freshStatus = { ...status, user: updatedUser, updatedAt: Date.now() };
      await saveStatus(freshStatus);

      // Keep ~/.pounding/config.json in sync with the current API key.
      if (status.token) {
        writePoundingConfig(status.token, status.baseUrl || undefined);
      }

      // Self-heal the managed provider in the backend DB.
      try {
        if (status.token && status.models.length > 0) {
          const provider = await findManagedProvider();
          if (!provider) {
            console.warn('[POUNDING] Managed provider missing from backend DB — restoring on refresh');
            await upsertManagedProvider({
              apiKey: status.token,
              models: status.models,
              baseUrl: status.baseUrl || undefined,
            });
          }
        }
      } catch (error) {
        console.warn('[POUNDING] Failed to self-heal managed provider on refresh:', error);
      }

      // Sync WebUI credentials on every startup refresh, not just login.
      // Uses the API token as the WebUI password — same credential the user
      // already has from the desktop login flow.
      try {
        const username = updatedUser.username?.trim() || status.user?.username?.trim();
        if (username && status.token) {
          await httpRequest('POST', '/api/auth/internal/users/sync-credentials', {
            username,
            password: status.token,
          });
        }
      } catch {
        // Non-fatal — WebUI password sync is best-effort on refresh
      }

      return { success: true, data: freshStatus };
    } catch (error) {
      console.warn('[POUNDING] Failed to refresh status from API:', error);
      return { success: true, data: status };
    }
  }

  async login(params: NewApiLoginParams): Promise<BridgeResponse<NewApiLoginResponse>> {
    const { username, password } = params;
    if (!username.trim() || !password) {
      return {
        success: false,
        msg: 'Username and password are required',
      };
    }

    try {
      const loginResult = await fetchJson<NewApiResponse<Record<string, unknown>>>('/api/user/login', {
        method: 'POST',
        body: { username, password },
      });
      const cookies = loginResult.cookies;
      const loginPayload = loginResult.data?.data ?? loginResult.data;
      const loginToken = extractToken(loginPayload) ?? extractToken(loginResult.data);
      // Diagnose the login/token chain: log whether the platform's login
      // response carried a token (missing token ⇒ all later requests 401).
      console.log('[POUNDING] login: response ok, token=', loginToken ? 'present' : 'MISSING', {
        payloadKeys: Object.keys(loginPayload ?? {}),
        dataKeys: isRecord(loginResult.data) ? Object.keys(loginResult.data) : [],
      });
      // Try to resolve the user ID from the login payload or the login token (JWT fallback).
      // If neither provides it, use an empty string — fetchJson skips the New-Api-User
      // header when the value is empty, and the /api/user/self endpoint authenticates via
      // cookies + Bearer token alone. The real user ID is extracted from the self response.
      const resolvedUserId = extractUserId(loginPayload) ?? extractUserId(loginToken) ?? '';

      const { token, baseUrl: providerBaseUrl } = await resolveManagedToken(cookies, loginToken, resolvedUserId);

      const selfResult = await fetchJson<NewApiResponse<unknown>>('/api/user/self', {
        cookies,
        token,
        userId: resolvedUserId,
      });
      const user = normalizeUser(selfResult.data?.data ?? selfResult.data ?? loginPayload, username.trim());

      // Fetch models for the POUNDING group. Returns a flat string array.
      const modelsResult = await fetchJson<NewApiResponse<unknown>>('/api/user/models?group=POUNDING', {
        cookies,
        token,
        userId: resolvedUserId,
      });
      const models = normalizeModelList(modelsResult.data?.data ?? modelsResult.data);

      await upsertManagedProvider({
        apiKey: token,
        models,
        baseUrl: providerBaseUrl,
      });

      // Write ~/.pounding/config.json immediately so skills (pounding-ozon etc.)
      // can read the API key even before the user configures any CLI.
      writePoundingConfig(token, providerBaseUrl);

      // Sync WebUI local user credentials so the bundled WebUI login accepts
      // the same username/password as the POUNDING API account. The backend
      // bcrypt-hashes the password server-side and writes to the users table.
      try {
        await httpRequest('POST', '/api/auth/internal/users/sync-credentials', {
          username: username.trim(),
          password, // plaintext — backend hashes it
        });
      } catch (error) {
        console.warn('[POUNDING] Failed to sync WebUI credentials:', (error as Error)?.message ?? error);
      }

      const status: NewApiAccountStatus = {
        loggedIn: true,
        baseUrl: providerBaseUrl,
        models,
        updatedAt: Date.now(),
        user,
        token,
        cookies,
        managedProviderId: NEW_API_MANAGED_PROVIDER_ID,
      };

      await saveStatus(status);

      return {
        success: true,
        data: { status },
      };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async logout(): Promise<BridgeResponse> {
    await removeManagedProvider().catch((): void => undefined);
    try {
      clearPoundingConfig();
    } catch {
      /* best-effort */
    }
    await clearPersistedStatus().catch((): void => undefined);
    await saveStatus({
      ...EMPTY_STATUS,
      updatedAt: Date.now(),
    });
    return { success: true };
  }
}

export const newApiDesktopAccountService = new NewApiDesktopAccountService();
