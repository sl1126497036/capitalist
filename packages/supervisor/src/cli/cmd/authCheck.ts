/**
 * 登录态检查。
 *
 * 一次执行给出宿主、通道结论与令牌来源。探测只发一句最小提示，不写任务数据，不改状态。
 *
 * ## 判定口径
 *
 * 结论以探测为准：探测按工作进程的环境与令牌运行，探测通过即代表派单与对话可用。
 * 本命令不读取宿主持久化凭据，也不判断其文件状态：能否认证由宿主 CLI 自身决定。
 */

import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

import { findRoot } from "../../core/record/paths";
import { loadSupervisor } from "../../core/record/supervisor";
import { byId } from "../../agent/registry";
import { looksLikeAuth, looksLikeQuota } from "../../supervisor/channel/llm";
import { officialAccessToken, officialTokenSource } from "../../supervisor/channel/officialToken";
import { detectWorkerHost, findBin, workerEnv, type WorkerHost } from "../../supervisor/worker/worker";
import { flagBool, flagString, type Parsed } from "../args";
import { write, writeJson } from "../output";

/** 探测提示：只用于取得通道结论。 */
const PROBE_PROMPT = "ok";
/** 探测上限。正常往返数秒；超时按通道不可用处理。 */
const PROBE_TIMEOUT_MS = 60_000;
/** 原文保留长度。 */
const RAW_LIMIT = 200;

type ProbeKind = "ok" | "auth" | "quota" | "timeout" | "error" | "missing" | "skipped";

interface ProbeResult {
  kind: ProbeKind;
  /** 失败时的原文摘要，供人工核对；成功时为空。 */
  raw: string;
}

/**
 * 探测用的子进程环境。
 *
 * 与工作进程、对话通道同口径：宿主声明了令牌变量且令牌可用时写入，探测反映的才是实际
 * 会被使用的通道。读不到令牌时按原样探测，结论仍是真实的。
 */
function probeEnv(host: WorkerHost): Record<string, string> {
  const env = workerEnv();
  const authVar = byId(host)?.worker?.authEnvVar;
  if (!authVar) return env;
  const token = officialAccessToken();
  if (token) env[authVar] = token;
  return env;
}

function probeHost(host: WorkerHost): ProbeResult {
  const bin = findBin(host);
  if (!bin) return { kind: "missing", raw: "" };
  const win = process.platform === "win32";
  const args = ["-p", PROBE_PROMPT, "--output-format", "text"];
  let r;
  try {
    r = spawnSync(bin, args, {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      shell: win,
      env: probeEnv(host),
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    return { kind: "error", raw: String((err as Error).message ?? err).slice(0, RAW_LIMIT) };
  }
  const raw = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  const brief = raw.slice(0, RAW_LIMIT);
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") return { kind: "timeout", raw: brief };
  if (looksLikeAuth(raw)) return { kind: "auth", raw: brief };
  if (looksLikeQuota(raw)) return { kind: "quota", raw: brief };
  if (r.status === 0 && String(r.stdout ?? "").trim().length > 0) return { kind: "ok", raw: "" };
  return { kind: "error", raw: brief || `退出码 ${String(r.status ?? "-")}` };
}

/**
 * 认证被拒时的结论。
 *
 * 令牌可用仍被拒说明令牌过期或无权，令牌缺失说明尚未登录。两种情况都指向同一条命令：
 * 在宿主中重新登录。
 */
function verdictOfAuth(tokenHeld: boolean): { verdict: string; action: string } {
  if (tokenHeld) {
    return {
      verdict: "宿主拒绝认证：令牌无效或已过期。",
      action: "在宿主中重新登录，然后重启监工。",
    };
  }
  return {
    verdict: "宿主未认证：未取得访问令牌。",
    action: "在宿主 CLI 中完成登录，然后重启监工。",
  };
}

/** 复现探测用的完整命令：与命令内部实际执行的参数一致，便于人工核对。 */
function probeCommand(host: string): string {
  return `${host} -p ${PROBE_PROMPT} --output-format text`;
}

function verdictOfProbe(
  kind: ProbeKind,
  host: string,
  tokenHeld: boolean,
): { verdict: string; action: string } {
  switch (kind) {
    case "ok":
      return {
        verdict: "登录态可用。",
        /*
         * 探测带的是当前可用的令牌，与实际派单口径一致。令牌来自启动命令的读取结果，
         * 已写进环境；监工若未持有，说明启动时那次读取被拒，需要重跑一次并允许弹窗。
         */
        action: tokenHeld
          ? ""
          : "监工未持有令牌：重新执行启动命令，在授权弹窗中选择“本次会话内始终允许”。",
      };
    case "auth":
      return verdictOfAuth(tokenHeld);
    case "quota":
      return { verdict: "通道额度耗尽。", action: "等待额度恢复后重试。" };
    case "timeout":
      return {
        verdict: "探测超时，通道不可用。",
        action: `先直接执行该命令核对耗时：${probeCommand(host)}。同样超时说明与登录态无关，检查项目 hook 与所在卷的启动开销。`,
      };
    case "missing":
      return { verdict: `未找到 ${host} 可执行文件。`, action: "安装宿主 CLI，或用 --agent 指定。" };
    default:
      return {
        verdict: "探测失败，未取得登录结论。",
        action: `按上方原文核对，或执行该命令复现：${probeCommand(host)}`,
      };
  }
}

const KIND_LABEL: Record<ProbeKind, string> = {
  ok: "通过",
  auth: "失败 · Authentication required",
  quota: "失败 · 额度耗尽",
  timeout: "失败 · 超时",
  error: "失败",
  missing: "未找到可执行文件",
  skipped: "跳过（--no-probe）",
};

/** 登录态检查。可用时退出码 0，其余 1。 */
export function cmdAuthCheck(p: Parsed): number {
  const explicit = String(flagString(p, "agent") ?? "").trim();
  const root = String(flagString(p, "root") ?? findRoot() ?? "");
  let rec: ReturnType<typeof loadSupervisor> = null;
  if (root) {
    try {
      rec = loadSupervisor(root);
    } catch {
      rec = null;
    }
  }

  /*
   * 宿主取值顺序：显式声明 -> 监工记录里的工作进程宿主 -> 环境探测。
   * 新任务根没有监工记录，此时按探测结果判定，避免在安装后的第一个目录里报“未指定宿主”。
   * 不在本命令里做同族替换：检查的目标是用户实际使用的那个入口。
   */
  const host = (explicit || String(rec?.worker_host ?? "").trim() || detectWorkerHost() || "") as WorkerHost;
  if (!host) {
    write("未指定宿主。加 --agent，或在任务根内执行。\n");
    return 1;
  }

  const skipProbe = flagBool(p, "no-probe");
  const result: ProbeResult = skipProbe ? { kind: "skipped", raw: "" } : probeHost(host);
  /* 监工是否持有启动时传入的令牌；只读有无，值从不落盘。 */
  const tokenHeld = rec?.token_injected === true;
  const { verdict, action } = skipProbe
    ? {
        verdict: "未做通道探测，登录态未判定。",
        action: "去掉 --no-probe 重跑。",
      }
    : verdictOfProbe(result.kind, host, tokenHeld);

  const ok = result.kind === "ok";

  if (flagBool(p, "json")) {
    writeJson({
      host,
      supervisor_host: String(rec?.host ?? ""),
      supervisor_token: tokenHeld,
      probe: result.kind,
      verdict,
      action,
      ok,
    });
    return ok ? 0 : 1;
  }

  const lines: string[] = [`宿主 ${host}`];
  if (rec) lines.push(`监工宿主 ${String(rec.host ?? "")}，工作进程 ${host}`);
  lines.push(`探测 ${KIND_LABEL[result.kind]}`);
  if (result.raw) lines.push(`原文 ${result.raw.replace(/\s+/g, " ").trim()}`);
  const authVar = byId(host)?.worker?.authEnvVar;
  if (authVar && !skipProbe) {
    const source = officialTokenSource();
    const where =
      source === "env" ? "启动时取到，已随环境传入"
        : source === "host" ? "宿主登录态，仅内存"
          : "未取到";
    lines.push(`令牌 ${where}（写入 ${authVar}）`);
  }
  if (rec) {
    lines.push(`监工令牌 ${tokenHeld ? "已持有（仅内存）" : "未持有：派单与对话会报登录失败"}`);
  }
  lines.push(`结论 ${verdict}`);
  if (action) lines.push(`处理 ${action}`);
  write(`${lines.join("\n")}\n`);
  return ok ? 0 : 1;
}
