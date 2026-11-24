/**
 * 进程原语：判活与阻塞睡眠。
 *
 * 进程判活与阻塞睡眠的唯一实现：入参守卫统一处理 `pid <= 0`。与 `agent/orphanGuard.ts` 的 `supervisorPidAlive` 判据不同（EPERM 按不存在处理），两者不可互相替代。
 *
 * 与 `agent/orphanGuard.ts` 的 `supervisorPidAlive` 有意不同：那份把 EPERM 当存活
 * （无权限发信号说明进程存在），用于父进程被判定失败时的自保判定；这里是通用判活，
 * EPERM 按不存在处理。两者不可互相替代。
 */

/**
 * 进程是否还在。
 *
 * 用信号 0 只探测存在性，不真的发信号。`pid <= 0` 必须在调用 kill 之前拦掉：
 * POSIX 下 `kill(0, 0)` 探测的是整个进程组、`kill(-1, 0)` 探测所有可见进程，
 * 都会返回成功，把“没有 pid”误判成“进程还在”。
 *
 * @param pid 进程号。非正整数按不存在处理。
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 同步睡眠指定毫秒。
 *
 * `Atomics.wait` 是 Node 里唯一不依赖定时器的阻塞原语，锁重试、轮询判活这类路径需要它
 * 才能不引入异步调用链。三处差异合并时取超集：`ms <= 0` 直接返回（`Atomics.wait` 对负值
 * 抛 RangeError），`Atomics` 不可用时放弃等待（等不到比抛错安全，等不下去由调用方按超时处理）。
 */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 环境不支持阻塞等待：放弃本次等待，限速与重试退化为立即继续 */
  }
}
