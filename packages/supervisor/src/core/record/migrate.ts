/**
 * 旧命名迁移：把上一版落盘的数据改到当前命名。
 *
 * 改名只动了代码，磁盘上已有的任务根仍按旧名书写：`state.json` 的 `contract`、
 * 台账里的 `contract_*` 事件、`config/contract-prev.json` 这类文件名。不迁则读出空守卫、
 * 历史事件在面板上变成未知类型。这里一次改净，之后代码只认新名。
 *
 * 三条硬要求：
 * - **幂等**：检测不到旧痕迹立即返回，热路径（每次读状态）只多几次 `existsSync`。
 * - **可回滚**：改写前把原文件复制到 `archive/migrate-<时间戳>/`。迁移只改名不改语义，
 *   出错时按备份还原，不需要反推。
 * - **不阻断**：单项失败记进报告后继续跑。迁移是升级的附带动作，失败不该让监工起不来。
 *
 * 数据库迁移的常规做法，不引入版本号之类的状态位：判据就看数据本身有没有旧名，
 * 迁移过之后判据自然为假。少了状态位，也就没有"标记说迁过但数据又被换回旧版"的错位。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

import { archive, config as configLoc, ledger as ledgerLoc, reload as reloadLoc, runtime } from "./locations";
import { readJson, writeAtomic, writeJson } from "./json";
import { supervisorDir } from "./paths";

/** 迁移报告。`changed` 为空即"没有旧数据"，`--check` 据此判定。 */
export interface MigrateReport {
  /** 做过的改动，一条一句。 */
  changed: string[];
  /** 需要人看一眼、但没自动改的情况（新旧并存、目标已存在之类）。 */
  kept: string[];
  /** 单项失败。有值不影响其余项已迁移。 */
  errors: string[];
  /** 备份目录；没有改动时为空串。 */
  backupDir: string;
}

/** 迁移选项。 */
export interface MigrateOptions {
  /** 只检测不落盘。 */
  dryRun?: boolean | undefined;
  /**
   * 自动纳管配置文件的额外位置。
   *
   * 宿主配置目录那份由调用方传入：`core` 不含宿主信息，只看得到通用回落路径。
   */
  watchFile?: string | undefined;
}

/** state.json 的字段改名。新名优先：两者并存时保留新名，旧名删掉。 */
const STATE_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["contract", "policy"],
  ["contract_path", "policy_path"],
  ["contract_fallback", "policy_fallback"],
];

/**
 * 已废弃的阶段字段。
 *
 * 阶段机制已移除，字段留着会让状态看起来还有阶段在生效；`stage_entered_at` 还会被
 * 简报当成"本轮起始时刻"。删掉没有语义损失：真正的起始时刻在 `created_at`。
 */
const RETIRED_STATE_KEYS: readonly string[] = ["stage", "stage_entered_at", "stage_entered_at_ts"];

/**
 * 台账事件改名。
 *
 * 逐个列出而不用 `contract_` 前缀通配：通配会把将来某个不相干的事件也改掉，
 * 而这里要的是一份可核对的完整清单。
 */
const EVENT_RENAMES: Readonly<Record<string, string>> = {
  contract_change: "policy_change",
  contract_changed: "policy_changed",
  contract_error: "policy_error",
  contract_refused: "policy_refused",
  contract_reload: "policy_reload",
  contract_rollback_failed: "policy_rollback_failed",
  contract_unstable: "policy_unstable",
};

/**
 * 自动纳管配置的默认位置。
 *
 * 与 `core/platform/autowatch` 的回退路径一致，但不引用它：`autowatch` → `policy/init`
 * → `record/state` → 本模块，引过来就成环。宿主配置目录那份不在这里判断，由调用方传入。
 */
function defaultWatchFile(): string {
  const env = process.env.CAPITALIST_WATCH_CFG;
  if (env) return env;
  return join(homedir(), ".capitalist", "capitalist-watch.json");
}

/** 备份目录名的时间戳：本地时间到秒，人读友好且不会重名覆盖。 */
function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 迁移过程的记账本：改了什么、留了什么、哪项失败。 */
class Migration {
  readonly changed: string[] = [];
  readonly kept: string[] = [];
  readonly errors: string[] = [];
  private backupDir = "";

  constructor(
    readonly root: string,
    readonly dryRun: boolean,
  ) {}

  note(msg: string): void {
    this.changed.push(msg);
  }

  keep(msg: string): void {
    this.kept.push(msg);
  }

  /** 单项失败：记下来继续，迁移不是关键路径。 */
  fail(item: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.errors.push(`${item}：${msg}`);
  }

  /**
   * 改写前留一份原样副本。
   *
   * 任务根之外的文件（用户级纳管配置）按 `external-<文件名>` 归档：用相对路径会带 `..`，
   * 拼进备份目录后就跑到目录外面去了。
   */
  backup(file: string, as = ""): void {
    if (!existsSync(file)) return;
    /* 预演只报路径，不建目录：`--check` 的约定是不动磁盘。 */
    const dir = this.reserveBackupDir();
    if (this.dryRun) return;
    mkdirSync(dir, { recursive: true });
    const rel = relative(supervisorDir(this.root), file);
    const name = as || (rel && !rel.startsWith("..") ? rel : `external-${basename(file)}`);
    const dst = join(dir, name);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(file, dst);
  }

  /** 备份目录名按需生成：预演时也要能报出"会备份到哪"，但不落盘。 */
  private reserveBackupDir(): string {
    if (!this.backupDir) this.backupDir = join(archive.dir(this.root), `migrate-${stamp()}`);
    return this.backupDir;
  }

  report(): MigrateReport {
    return { changed: this.changed, kept: this.kept, errors: this.errors, backupDir: this.backupDir };
  }
}

/** 把 `from` 改名成 `to`；目标已存在时保留两者并提示人工确认。 */
function renameFile(mig: Migration, from: string, to: string, label: string): void {
  if (!existsSync(from)) return;
  if (existsSync(to)) {
    mig.keep(`${label}：${basename(to)} 已存在，保留 ${basename(from)} 未动`);
    return;
  }
  mig.backup(from);
  if (mig.dryRun) {
    mig.note(`${label}：${basename(from)} 改名为 ${basename(to)}`);
    return;
  }
  renameSync(from, to);
  mig.note(`${label}：${basename(from)} 改名为 ${basename(to)}`);
}

/** `state.json`：字段改名、清废弃字段、修守卫路径。 */
function migrateState(mig: Migration): void {
  const file = runtime.state(mig.root);
  const raw = readJson<Record<string, unknown> | null>(file, null);
  if (!raw || typeof raw !== "object") return;

  let touched = false;
  const renamed: string[] = [];

  for (const [oldKey, newKey] of STATE_FIELDS) {
    if (!(oldKey in raw)) continue;
    if (newKey in raw && raw[newKey] !== raw[oldKey]) {
      mig.keep(`state.json：${oldKey} 与 ${newKey} 并存且取值不同，保留 ${newKey}`);
    } else if (!(newKey in raw)) {
      raw[newKey] = raw[oldKey];
    }
    delete raw[oldKey];
    renamed.push(`${oldKey}→${newKey}`);
    touched = true;
  }

  let dropped = false;
  for (const k of RETIRED_STATE_KEYS) {
    if (!(k in raw)) continue;
    delete raw[k];
    dropped = true;
    touched = true;
  }

  /*
   * 守卫路径可能指向已下线的 `.contract.json`。
   *
   * 三种情形分开处理：同目录已有新后缀就改指过去；文件不在了置空；文件在但落在
   * `node_modules` 里也置空——那是随包分发的旧包内文件（当前样本正指向全局旧包的
   * `contracts/`），包升级或卸载后就失效，路径本身不该被长期引用。置空后由读取方
   * 按守卫名重新解析并写回，比留一个随时会断的绝对路径稳。
   */
  const path = String(raw.policy_path ?? "").trim();
  if (/\.contract\.json$/i.test(path)) {
    const next = path.replace(/\.contract\.json$/i, ".policy.json");
    if (existsSync(next)) {
      raw.policy_path = next;
      mig.note(`state.json：守卫路径改指 ${basename(next)}`);
    } else if (!existsSync(path) || /[\\/]node_modules[\\/]/.test(path)) {
      raw.policy_path = "";
      mig.note("state.json：守卫路径随旧包失效，置空后按守卫名重新解析");
    }
  }

  if (!touched) return;
  if (renamed.length > 0) mig.note(`state.json：字段 ${renamed.join("、")}`);
  if (dropped) mig.note("state.json：清掉已废弃的阶段字段");
  if (mig.dryRun) return;
  mig.backup(file);
  writeJson(file, raw);
}

/**
 * 单个 JSON 文件里的一个字段改名。
 *
 * `supervisor.json` 与重载快照各自只有这一个旧字段，处理方式完全相同，合成一处：
 * 分开写会让"新旧并存时以哪个为准"在两个函数里出现两份实现，日后只改一处就分叉。
 */
function renameJsonField(mig: Migration, file: string, from: string, to: string, label: string): void {
  const raw = readJson<Record<string, unknown> | null>(file, null);
  if (!raw || typeof raw !== "object" || !(from in raw)) return;
  if (!(to in raw)) raw[to] = raw[from];
  delete raw[from];
  mig.note(`${label}：${from}→${to}`);
  if (mig.dryRun) return;
  mig.backup(file);
  writeJson(file, raw);
}

/** 两个改写过的配置文件名。 */
function migrateConfigFiles(mig: Migration): void {
  renameFile(
    mig,
    join(configLoc.dir(mig.root), "contract-prev.json"),
    configLoc.policyPrev(mig.root),
    "上一版守卫",
  );
  renameFile(
    mig,
    join(reloadLoc.dir(mig.root), "contract-seen.json"),
    reloadLoc.policySeen(mig.root),
    "守卫变更登记",
  );
}

/**
 * 台账事件名。
 *
 * 逐行处理而不用 `readJsonl` 回写：台账是追加式的，任何一行解析不了都说明有别的进程
 * 写过非 JSON 内容，这种行必须原样留着，不能因为迁移把它丢了。
 */
function migrateEvents(mig: Migration): void {
  const file = ledgerLoc.events(mig.root);
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  if (!text.includes("contract_")) return;

  let hit = 0;
  const out = text.split("\n").map((line) => {
    if (!line.trim()) return line;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return line;
    }
    if (!row || typeof row !== "object") return line;
    const rec = row as Record<string, unknown>;
    let touched = false;
    for (const key of ["event", "kind"]) {
      const from = rec[key];
      const to = typeof from === "string" ? EVENT_RENAMES[from] : undefined;
      if (to) {
        rec[key] = to;
        touched = true;
      }
    }
    if (!touched) return line;
    hit += 1;
    return JSON.stringify(rec);
  });

  if (hit === 0) return;
  mig.note(`events.jsonl：${hit} 条事件改名`);
  if (mig.dryRun) return;
  mig.backup(file);
  writeAtomic(file, out.join("\n"));
}

/** 用户级自动纳管配置：`rules[].contract` 与示例里的同名字段。 */
function migrateWatch(mig: Migration, file: string): void {
  const raw = readJson<Record<string, unknown> | null>(file, null);
  if (!raw || typeof raw !== "object") return;

  let touched = false;
  const fix = (obj: Record<string, unknown>): void => {
    if (!("contract" in obj)) return;
    if (!("policy" in obj)) obj.policy = obj.contract;
    delete obj.contract;
    touched = true;
  };

  if (Array.isArray(raw.rules)) {
    for (const rule of raw.rules) {
      if (rule && typeof rule === "object") fix(rule as Record<string, unknown>);
    }
  }
  /* `_示例` 是写给用户看的模板，字段名不跟着改，用户照抄回来又成了旧名。 */
  const example = raw["_示例"] ?? raw["_example"];
  if (example && typeof example === "object") fix(example as Record<string, unknown>);

  if (!touched) return;
  mig.note(`纳管配置 ${basename(file)}：字段 contract→policy`);
  if (mig.dryRun) return;
  mig.backup(file, `watch-${basename(file)}`);
  writeJson(file, raw);
}

/**
 * 守卫文件后缀。
 *
 * 只改 `state.json` 指向的那一份：它是本任务实际在用的守卫，改名后路径要一起改。
 * 别的目录里的 `.contract.json` 不动，它们可能被外部脚本按路径引用；读取层仍认旧后缀，
 * 漏网的文件不会让任务根起不来。
 */
function migratePolicyFile(mig: Migration): void {
  const st = readJson<Record<string, unknown> | null>(runtime.state(mig.root), null);
  const path = String(st?.policy_path ?? st?.contract_path ?? "").trim();
  if (!/\.contract\.json$/i.test(path) || !existsSync(path)) return;
  /* 安装目录里的文件不归本任务根管：`state.json` 已改为置空引用，这里只跳过。 */
  if (/[\\/]node_modules[\\/]/.test(path)) return;
  const next = path.replace(/\.contract\.json$/i, ".policy.json");
  if (existsSync(next)) {
    mig.keep(`守卫文件 ${basename(next)} 已存在，保留 ${basename(path)} 未动`);
    return;
  }
  mig.backup(path, `policy-${basename(path)}`);
  if (mig.dryRun) return;
  renameSync(path, next);
  mig.note(`守卫文件：${basename(path)} 改名为 ${basename(next)}`);
}

/**
 * 迁移一个任务根。
 *
 * @param root 任务根。不存在 `.capitalist` 时报告为空，不算错误。
 * @returns 逐项报告。`changed` 为空表示磁盘上没有旧数据。
 */
export function migrateRoot(root: string, opts: MigrateOptions = {}): MigrateReport {
  const mig = new Migration(root, opts.dryRun === true);
  if (!existsSync(supervisorDir(root))) return mig.report();

  const steps: ReadonlyArray<readonly [string, () => void]> = [
    /* 守卫文件先改名，状态里那条路径才有新后缀可指；反过来会留下一年的失效路径。 */
    ["守卫文件", () => migratePolicyFile(mig)],
    ["状态", () => migrateState(mig)],
    ["监工记录", () => renameJsonField(mig, runtime.supervisor(root), "contract", "policy", "supervisor.json")],
    ["配置文件", () => migrateConfigFiles(mig)],
    ["重载快照", () =>
      renameJsonField(mig, reloadLoc.snapshot(root), "contract_freshness", "policy_freshness", "snapshot.json")],
    ["台账事件", () => migrateEvents(mig)],
    [
      "纳管配置",
      () => {
        /* 通用回落路径总是查；宿主目录那份由调用方传，去重后依次处理。 */
        const files = new Set<string>([defaultWatchFile()]);
        if (opts.watchFile) files.add(opts.watchFile);
        for (const f of files) {
          try {
            migrateWatch(mig, f);
          } catch (err) {
            mig.fail(`纳管配置 ${basename(f)}`, err);
          }
        }
      },
    ],
  ];

  for (const [name, run] of steps) {
    try {
      run();
    } catch (err) {
      mig.fail(name, err);
    }
  }
  return mig.report();
}
