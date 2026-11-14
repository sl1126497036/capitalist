/** 申报队列（`.capitalist/mq/reports.jsonl`）：工作进程 -> 监工的单向事件流。 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";

import { appendJsonl } from "../record/json";
import { supervisorDir } from "../record/paths";

export type MqKind = string;

/** 严重程度，决定监工要不要动用模型去判。 */
export type MqSeverity = "info" | "warn" | "critical";

/** 这条申报需要监工做什么。 */
export type MqNeeds = "none" | "decision" | "intervention";

/** 一条申报。 */
export interface MqMessage {
  id: string;
  at: string;
  at_ts: number;
  /** 发件的工作进程 id（`W-xxx`）。 */
  from: string;
  dispatch: string;
  stage: string;
  shard: string;
  kind: MqKind;
  severity: MqSeverity;
  text: string;
  /** 证据：日志片段、文件路径、命令输出。监工的判断主要靠它，不是靠自述。 */
  evidence?: string;
  needs: MqNeeds;
  /** 监工处理后的结论，由监工侧回填（工作进程不写）。 */
  verdict?: string;
  verdict_why?: string;
}

export function mqDir(root: string): string {
  return join(supervisorDir(root), "mq");
}

export function mqPath(root: string): string {
  return join(mqDir(root), "reports.jsonl");
}

function cursorPath(root: string): string {
  return join(mqDir(root), "cursor.json");
}

function newId(): string {
  return `M-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** 追加一条申报。返回落库后的完整记录。 */
export function appendMq(
  root: string,
  input: Omit<MqMessage, "id" | "at" | "at_ts"> & { id?: string },
): MqMessage {
  const msg: MqMessage = {
    id: input.id ?? newId(),
    at: new Date().toISOString(),
    at_ts: Date.now() / 1000,
    from: input.from,
    dispatch: input.dispatch,
    stage: input.stage,
    shard: input.shard,
    kind: input.kind,
    severity: input.severity,
    text: input.text,
    needs: input.needs,
    ...(input.evidence ? { evidence: input.evidence } : {}),
  };
  try {
    mkdirSync(mqDir(root), { recursive: true });
  } catch {
    /* 目录已存在 */
  }
  appendJsonl(mqPath(root), msg);
  return msg;
}

/** 消费位置（字节偏移）。缺失即从头读。 */
function readCursor(root: string): number {
  try {
    const raw = JSON.parse(readFileSync(cursorPath(root), "utf8")) as { offset?: number };
    const n = Number(raw.offset ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** 记下消费位置。只前进，不回退，重放旧消息会把已经处理过的结论再执行一次。 */
export function commitCursor(root: string, offset: number): void {
  const cur = readCursor(root);
  if (offset <= cur) return;
  try {
    mkdirSync(mqDir(root), { recursive: true });
    writeFileSync(cursorPath(root), JSON.stringify({ offset, at: new Date().toISOString() }));
  } catch {
  }
}

/**
 * 读尚未消费的申报，并给出新的消费位置。
 *
 * 逐行解析：坏行跳过但不阻断后面的行，同时把“跳过了几行”报出来，一条写坏的记录
 * 不该让整批申报都读不到，也不应被静默忽略。
 */
export function readPendingMq(root: string): {
  messages: MqMessage[];
  nextOffset: number;
  skipped: number;
} {
  const file = mqPath(root);
  if (!existsSync(file)) return { messages: [], nextOffset: readCursor(root), skipped: 0 };
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return { messages: [], nextOffset: readCursor(root), skipped: 0 };
  }
  const from = Math.min(readCursor(root), size);
  if (from >= size) return { messages: [], nextOffset: from, skipped: 0 };

  let text = "";
  try {
    const fd = readFileSync(file);
    text = fd.subarray(from).toString("utf8");
  } catch {
    return { messages: [], nextOffset: from, skipped: 0 };
  }
  /* 只消费到最后一个换行：半行留给下一次，否则会解析出半条记录。 */
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) return { messages: [], nextOffset: from, skipped: 0 };
  const consumed = text.slice(0, lastNl + 1);
  const nextOffset = from + Buffer.byteLength(consumed, "utf8");

  const messages: MqMessage[] = [];
  let skipped = 0;
  for (const line of consumed.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as MqMessage;
      if (typeof row.id !== "string" || typeof row.kind !== "string") {
        skipped += 1;
        continue;
      }
      messages.push(row);
    } catch {
      skipped += 1;
    }
  }
  return { messages, nextOffset, skipped };
}

/** 推送唤醒：告诉监工“有新的申报，现在就看”。 */
export function wakeSupervisor(root: string, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    let base = "";
    try {
      const capitalist = JSON.parse(readFileSync(join(supervisorDir(root), "supervisor.json"), "utf8")) as {
        board_url?: string;
      };
      base = String(capitalist.board_url ?? "").trim();
    } catch {
      resolve(false);
      return;
    }
    if (!/^https?:\/\//.test(base)) {
      resolve(false);
      return;
    }
    let url: URL;
    try {
      url = new URL("/api/mq", base);
    } catch {
      resolve(false);
      return;
    }
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": 2 },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode === 200));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end("{}");
  });
}
