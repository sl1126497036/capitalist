/**
 * 退出清理表。看板端口与工作进程随监工一并释放；登记与执行分离，创建成功后登记幂等清理函数。
 * SIGINT、SIGTERM、`capitalist supervise-stop` 与 `beforeExit` 共用 {@link disposeAll}。
 * 清理按登记逆序执行且只执行一次，避免重复关闭抛错。
 */

/** 清理函数须同步且不抛；抛错只记录，不中断后续清理。 */
export type Disposer = () => void;

interface Entry {
  name: string;
  fn: Disposer;
}

const entries: Entry[] = [];
let disposed = false;

/** 资源创建成功后登记；创建失败不登记。 */
export function registerDisposer(name: string, fn: Disposer): void {
  entries.push({ name, fn });
}

/**
 * 执行全部清理。
 *
 * @param reason 触发原因，仅用于报错文案（`shutdown` / `beforeExit` 等）。
 * @returns 失败项的描述，空数组表示全部成功。第二次调用恒返回空数组。
 */
export function disposeAll(reason: string): string[] {
  if (disposed) return [];
  disposed = true;

  const failures: string[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (!e) continue;
    try {
      e.fn();
    } catch (err) {
      failures.push(`${e.name}: ${String((err as Error)?.message ?? err)}（${reason}）`);
    }
  }
  entries.length = 0;
  return failures;
}

/** 测试用：清空登记并复位「已清理」标记。 */
export function __resetDisposers(): void {
  entries.length = 0;
  disposed = false;
}
