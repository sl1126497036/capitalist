/**
 * 启动时的登录态诊断。
 *
 * 只在令牌下发开启时读取一次宿主登录态。读取由本进程发起，不接收外部传入的令牌；
 * 令牌只写进本进程环境，由监工、对话通道与工作进程共用。令牌不进 argv、不写文件、
 * 不写日志、不写 supervisor.json。
 *
 * 诊断结论写入 `.capitalist/auth-diag.json`：只含判定与错误码，供重启后回看读取落在
 * 哪一层。读取失败的提示只出现在 stdout。
 */

import { join } from "node:path";

import { supervisorDir } from "../../core/record/paths";
import { writeJson } from "../../core/record/json";
import { t } from "../lang";
import { write } from "../output";

export async function runAuthDiag(root: string): Promise<void> {
  const tok = await import("../../supervisor/channel/officialToken");
  const diagFile = join(supervisorDir(root), "auth-diag.json");
  const saveDiag = (value: unknown): void => {
    try {
      writeJson(diagFile, value);
    } catch {
      /* 诊断写失败不影响启动 */
    }
  };

  if (!tok.tokenInjectionEnabled()) {
    write(
      t(
        "[supervisor] no host token injected; workers and the chat channel use the host CLI login.\n",
        "[监工] 未下发宿主令牌：工作进程与对话通道使用宿主自身的登录态。\n",
      ),
    );
    saveDiag({ injection: "off" });
    return;
  }

  if (!tok.tokenInjectorPresent()) {
    write(
      t(
        "[supervisor] no host token injected: injector not found.\n",
        "[监工] 未下发宿主令牌：注入组件不存在。\n",
      ),
    );
    saveDiag(tok.hostTokenDiag());
    return;
  }

  const source = tok.warmHostToken();
  saveDiag(tok.hostTokenDiag());

  if (source !== "none") {
    write(
      t(
        "[supervisor] host token acquired; chat and dispatch use it without further prompts.\n",
        "[监工] 已取得宿主令牌：对话与派单直接使用，不会再询问。\n",
      ),
    );
    return;
  }

  const failure = tok.officialTokenFailure();
  const code = String(tok.hostTokenDiag()["errorCode"] ?? "");
  const en =
    failure === "missing"
      ? "[supervisor] host token unavailable: login state not visible. If the host is signed in, the sandbox reports it as missing; see .capitalist/auth-diag.json.\n"
      : failure === "encrypted"
        ? "[supervisor] host token unavailable: login state is encrypted and cannot be read.\n"
        : `[supervisor] host token unavailable: authorization denied or timed out${code ? ` (${code})` : ""}. Restart the supervisor and choose "always allow for this session" in the prompt.\n`;
  const zh =
    failure === "missing"
      ? "[监工] 未取得宿主令牌：宿主登录态不可见。若宿主已登录，说明沙箱导致文件存在性判定误报，详见 .capitalist/auth-diag.json。\n"
      : failure === "encrypted"
        ? "[监工] 未取得宿主令牌：宿主登录态为加密格式，无法取出访问令牌。\n"
        : `[监工] 未取得宿主令牌：授权请求被拒或未响应${code ? `（${code}）` : ""}，重启监工并在弹窗中选择“本次会话内始终允许”。\n`;
  write(t(en, zh));
}
