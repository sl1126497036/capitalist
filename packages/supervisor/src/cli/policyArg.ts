/**
 * 守卫参数的取值入口。
 *
 * 旧名 `--contract` 已下线。静默忽略会让 `--contract generic` 被当成“未指定守卫”，
 * 回落 minimal，原本生效的领域红线随之失效，所以这里必须显式拒绝并指路。
 */

import { flagString, type Parsed } from "./args";
import { t } from "./lang";
import { die } from "./output";

export function policyArgOf(p: Parsed): string | undefined {
  if (p.flags.contract !== undefined) {
    die(
      t(
        "--contract has been renamed to --policy; rerun with --policy <name|path>",
        "`--contract` 已更名为 `--policy`，请改用 `--policy <名|路径>` 重新执行",
      ),
    );
  }
  return flagString(p, "policy");
}
