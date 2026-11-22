/**
 * 插话状态词的拆分与档位判定。
 *
 * 服务端下发插话状态时，会把结论接在主状态后面：先写“已并入派单”，再接“已落实”，
 * 两段之间用一个中点分隔。判定只看主状态，结论原样带回。整串比对会把带结论的记录
 * 判成未知状态。
 *
 * 分隔符写 Unicode 转义，不直接写出字符：该符号在界面文案中禁用，写在源码里容易被
 * 后续维护者照抄到界面上。
 *
 * 本模块不依赖界面运行时，界面与测试共用同一判据。
 */

/** 主状态与结论之间的分隔符：空格、中点、空格。 */
const SEP = " \u00b7 ";

/**
 * 拆成主状态与结论段。
 *
 * 无结论时结论为空数组，主状态为原串。
 */
export function splitStatus(s) {
  const v = String(s ?? "");
  const cut = v.indexOf(SEP);
  if (cut < 0) return { head: v, tail: [] };
  return {
    head: v.slice(0, cut),
    tail: v
      .slice(cut + SEP.length)
      .split(SEP)
      .map((x) => x.trim())
      .filter(Boolean),
  };
}

/**
 * 用户插话的送达档位：`ok` 已送达，`pending` 待送达，`bad` 未送达。
 *
 * 气泡尾标只回答一个问题：这条插话送到了没有。并入哪张单、进程在什么间隙取走、
 * 送过之后的结论如何，都不进气泡，需要时由悬停提示给出。
 *
 * 任何输入都要有档位。本地回显、老记录、状态词为空一律落到 `pending`。早先按白名单
 * 逐条比对，认不出的状态返回空串，气泡上那个位置整块消失，读起来就是时有时无。
 */
export function interjectTone(s) {
  const { head } = splitStatus(s);
  if (head === "rejected" || head === "未投递") return "bad";
  /* 已并入派单表示监工已接收、随该单生效；已送达执行中的进程表示进程已收到。两者都算送到。 */
  if (head === "已送达执行中的进程" || head === "已并入派单" || head === "executed") return "ok";
  return "pending";
}

/**
 * 档位的先后次序：未送达 2，已送达 1，待送达 0。
 *
 * 合并消息时用它比较新旧两条记录，取值大的留下。送达状态只前进不后退：前端会跨轮次
 * 保留读过的消息，旧对象一旦把“已送达”覆盖回“待送达”，尾标就在两个词之间来回跳。
 */
export function interjectRank(s) {
  const tone = interjectTone(s);
  return tone === "bad" ? 2 : tone === "ok" ? 1 : 0;
}

/**
 * 同一条消息两次下发时的取舍。
 *
 * 常规情况整条取新对象，正文与状态都用最新。用户插话例外：送达状态不得倒退。
 * 前端跨轮次保留读过的消息，旧对象带回的“待送达”一旦覆盖“已送达”，尾标就在两个词
 * 之间来回跳。
 */
export function mergeInterject(oldM, newM) {
  const interject = String(oldM?.role || "") === "user" && String(oldM?.kind || "") === "say";
  if (!interject) return newM;
  return interjectRank(newM?.status) < interjectRank(oldM?.status) ? { ...newM, status: oldM.status } : newM;
}


