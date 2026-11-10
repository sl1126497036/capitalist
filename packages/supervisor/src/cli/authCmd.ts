/**
 * `capitalist auth` 入口。
 *
 * 命令已移除：认证与续期由宿主 CLI 完成，插件不读取、不保存登录态，
 * 也不访问宿主的凭证目录。
 */

import type { Parsed } from "./args";
import { writeErr } from "./output";

export async function cmdAuth(_p: Parsed): Promise<number> {
  writeErr("auth 已移除。认证由宿主 CLI 完成，插件不读取也不保存登录态。\n");
  return 1;
}
