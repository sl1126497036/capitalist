/**
 * 命令行的输出出口。
 *
 * 命令实现只调这里，不直接碰 `process.stdout` 与 `process.exit`。
 */

/** 正常输出一行（调用方自带换行）。 */
export function write(text: string): void {
  process.stdout.write(text);
}

/** 错误输出一行（调用方自带换行）。 */
export function writeErr(text: string): void {
  process.stderr.write(text);
}

/** 打印一个 JSON 结果。统一 2 空格缩进，便于人读与 diff。 */
export function writeJson(value: unknown): void {
  write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * 以非零状态结束进程。
 *
 * 用于参数不对、前置条件不满足这类无法继续的情形。消息必须说清发生了什么、下一步怎么改。
 */
export function die(message: string): never {
  writeErr(`${message}\n`);
  process.exit(1);
}
