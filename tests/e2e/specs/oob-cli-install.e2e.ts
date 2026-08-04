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

// 后端就绪等待窗口（默认 120s）。macos-x64 的 OOB 在 arm64 runner 上用
// Rosetta 跑 x64 包，冷启动 + 首启物化更慢，release workflow 对
// macos-x64 注入 E2E_BACKEND_READY_SECONDS=300。
const BACKEND_READY_SECONDS = Number(process.env.E2E_BACKEND_READY_SECONDS ?? 120);

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
    // 非阻断快检：后端就绪 + 每个 CLI 状态可报告（可用/未装/原因），
    // 不做安装、不轮询可用性、不因 CLI 缺失而失败。
    // 测试体超时须覆盖就绪窗口（macos-x64 为 300s）+ 后续检查余量。
    test.setTimeout(Math.max(180_000, BACKEND_READY_SECONDS * 1000 + 30_000));

    // 等待后端就绪（__backendPort 由 preload 注入，httpGet 失败会抛错）。
    // 默认 120s：Rosetta / 慢机上打包应用后端冷启动可能超过 60s
    // （macos-arm64 快所以早先通过）。macos-x64 由 CI 注入更长窗口。
    let report: AgentDiagnosticReport | null = null;
    for (let i = 0; i < Math.ceil(BACKEND_READY_SECONDS / 5) && !report; i++) {
      try {
        report = await httpGet<AgentDiagnosticReport>(page, '/api/doctor/diagnose');
      } catch {
        await page.waitForTimeout(5000);
      }
    }
    expect(report, `backend 未在 ${BACKEND_READY_SECONDS}s 内就绪`).toBeTruthy();

    // CLI 不再捆绑进安装器（自助管理：设置→Agent 运行环境）。桌面侧仍把
    // 托管 CLI 目录（~/.local/bin 等）注入 poundingcore 的 PATH
    // （backend-launcher buildSpawnEnv），后端 doctor/repair 能找到已安装
    // 的 CLI。缺失仅 warn，不阻断 release——因此这里只要求"状态可报告"。
    const TARGETS: Array<'claude' | 'hermes' | 'openclaw'> = ['claude', 'hermes', 'openclaw'];
    const missing: string[] = [];

    for (const target of TARGETS) {
      // repair 只是后端单行重探测（不安装），随后读取一次状态并如实报告。
      const repair = await httpPost<RepairResult>(page, '/api/doctor/repair', { target });
      console.log(`[OOB] repair ${target}: success=${repair?.success} source=${repair?.source} error=${repair?.error}`);

      const r = await httpGet<AgentDiagnosticReport>(page, '/api/doctor/diagnose');
      const agent = findAgent(r, target);
      // 状态必须可报告（available 是布尔、reason 可空）；可用性本身不硬断言。
      expect(agent, `doctor 报告缺少 ${target} 的状态条目（backend=${target} 未出现在 diagnose 中）`).toBeDefined();
      if (agent!.available) {
        console.log(`[OOB] ${target}: ✅ available`);
      } else {
        console.warn(`[OOB] ${target}: ⚠️ 不可用（reason=${agent?.reason ?? 'not found'}）`);
        missing.push(target);
      }
    }

    // 汇总非阻断提示（保留 OOB 日志可读性，不 fail）。
    if (missing.length > 0) {
      console.warn(`[OOB] CLI 未安装（非阻断）：${missing.join(', ')} — 用户可在 设置→Agent→运行环境 自助安装`);
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
