/**
 * OOB Gate — 开箱即用验证（release 产物）
 *
 * 只在 release 构建的打包产物上运行（`E2E_PACKAGED=1` + `E2E_OOB_GATE=1`，
 * 由 _build-reusable.yml 的 "Verify OOB CLI install + builtin MCP" 步骤设置）。
 * 普通 PR/本地 e2e（E2E_DEV 模式，无内置资源）跳过。
 *
 * 验证三件事：
 * 1. 打包应用能启动、后端就绪，claude / hermes / openclaw 状态可报告
 *    （CLI 不再捆绑：可用性为非阻断 warn，助手页"运行环境"自助安装）
 * 2. chrome-devtools 内置 MCP 默认启用
 * 3. pounding-image-generation 内置 MCP 默认启用
 *
 * MCP 任一失败 → release job 失败（宁可不发也不发 MCP 不默认开的包）。
 */
import { test, expect } from '../fixtures';
import { httpGet, httpPost } from '../helpers';

const OOB_ENABLED = process.env.E2E_OOB_GATE === '1' && process.env.E2E_PACKAGED === '1';

type AgentDiagnosticReport = {
  agents: Array<{
    name: string;
    backend: string | null;
    available: boolean;
    reason: string | null;
    bundledSource: boolean;
  }>;
  runtimes: Record<string, { available: boolean; path: string | null }>;
  summary: { healthy: boolean; issues: string[] };
};

type RepairResult = {
  success: boolean;
  source: string | null;
  error: string | null;
};

type McpServerRow = {
  id: string;
  name: string;
  enabled: boolean;
  builtin: boolean;
};

/** 按 backend 字段在 doctor 报告里找 agent（大小写不敏感）。 */
function findAgent(
  report: AgentDiagnosticReport,
  backend: string
): AgentDiagnosticReport['agents'][number] | undefined {
  const lowerBackend = backend.toLowerCase();
  return report.agents.find(
    (a) => (a.backend ?? '').toLowerCase() === lowerBackend || a.name.toLowerCase().includes(lowerBackend)
  );
}

test.describe('OOB Gate — 开箱即用', () => {
  test.skip(!OOB_ENABLED, '仅 release 打包产物验证：需 E2E_OOB_GATE=1 + E2E_PACKAGED=1');

  test('claude / hermes / openclaw 状态可报告（可用性非阻断）', async ({ page }) => {
    test.setTimeout(300_000);

    // 等待后端就绪（__backendPort 由 preload 注入，httpGet 失败会抛错）。
    // 120s 而非 60s：Intel mac（macos-x64 runner）与慢机上打包应用后端
    // 冷启动可能超过 60s（macos-arm64 快所以早先通过）。
    let report: AgentDiagnosticReport | null = null;
    for (let i = 0; i < 24 && !report; i++) {
      try {
        report = await httpGet<AgentDiagnosticReport>(page, '/api/doctor/diagnose');
      } catch {
        await page.waitForTimeout(5000);
      }
    }
    expect(report, 'backend 未在 120s 内就绪').toBeTruthy();

    // CLI 不再捆绑进安装器（自助管理：设置→Agent 运行环境）。桌面侧仍把
    // 托管 CLI 目录（~/.local/bin 等）注入 poundingcore 的 PATH
    // （backend-launcher buildSpawnEnv），后端 doctor/repair 能找到已安装
    // 的 CLI。缺失仅 warn，不阻断 release。
    const TARGETS: Array<{ target: 'claude' | 'hermes' | 'openclaw'; hard: boolean }> = [
      { target: 'claude', hard: false },
      { target: 'hermes', hard: false },
      { target: 'openclaw', hard: false },
    ];

    for (const { target, hard } of TARGETS) {
      // 先 repair：re-probe + 触发官方/COS 安装（网络可用时安装成功）
      const repair = await httpPost<RepairResult>(page, '/api/doctor/repair', { target });
      console.log(`[OOB] repair ${target}: success=${repair?.success} source=${repair?.source} error=${repair?.error}`);

      // 轮询 diagnose 直到可用（留 120s 余量，网络安装可能较慢）。
      let available = false;
      for (let i = 0; i < 24; i++) {
        await page.waitForTimeout(5000);
        const r = await httpGet<AgentDiagnosticReport>(page, '/api/doctor/diagnose');
        const agent = findAgent(r, target);
        if (agent?.available) {
          available = true;
          console.log(`[OOB] ${target}: ✅ available`);
          break;
        }
        console.log(`[OOB] ${target}: polling ${i + 1}, reason=${agent?.reason ?? 'not found'}`);
      }
      if (hard) {
        expect(available, `${target} 在打包产物启动后应可用（离线 bundle 安装），但 doctor 报告不可用`).toBe(true);
      } else {
        console.warn(`[OOB] ${target}: ${available ? '✅' : '⚠️ 不可用（已知架构缺口，见发布说明）'}`);
      }
    }
  });

  test('chrome-devtools + pounding-image-generation 内置 MCP 默认启用', async ({ page }) => {
    test.setTimeout(120_000);

    const servers = await httpGet<McpServerRow[]>(page, '/api/mcp/servers');
    expect(servers, 'MCP servers 列表为空').toBeDefined();

    const byName = new Map((servers ?? []).map((s) => [s.name, s]));
    const chrome = byName.get('chrome-devtools');
    const imageGen = byName.get('pounding-image-generation');

    console.log(
      `[OOB] MCP: chrome-devtools enabled=${chrome?.enabled} builtin=${chrome?.builtin}; ` +
        `pounding-image-generation enabled=${imageGen?.enabled} builtin=${imageGen?.builtin}`
    );

    expect(chrome, '内置 chrome-devtools MCP 应存在').toBeDefined();
    expect(chrome!.enabled, 'chrome-devtools MCP 应默认启用').toBe(true);
    expect(chrome!.builtin).toBe(true);

    expect(imageGen, '内置 pounding-image-generation MCP 应存在').toBeDefined();
    expect(imageGen!.enabled, 'pounding-image-generation MCP 应默认启用').toBe(true);
    expect(imageGen!.builtin).toBe(true);
  });
});
