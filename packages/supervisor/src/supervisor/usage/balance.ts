/**
 * 账号额度读数。
 *
 * 本项目不读宿主令牌，因此没有额度数据源：`balanceView` 恒返回不可用，
 * 看板按字段缺失处理，不显示额度格。保留本模块是为了让调用方不必各自判定。
 *
 * 曾用宿主登录态里的令牌查询计费接口。该路径需读取客户端落盘的令牌，
 * 开源版本已移除：令牌归宿主所有，本进程不读取。
 */

/** 余额视图。字段名固定，看板顶栏与 `/api/usage` 共用。 */
export interface BalanceView {
  /** 是否拿到了真实读数 */
  available: boolean;
  /** 余额（积分） */
  credit: number | null;
  /** 已用（积分），账号级 */
  credit_used: number | null;
  /** 单位 */
  credit_unit: string;
  /** 数据来源描述 */
  source: string;
  /** 读数时间（ISO）；没读到时为空串 */
  at: string;
  /** 不可用原因，可用时为空串。 */
  reason: string;
  /** 账号标识，取 uid 前 8 位。 */
  account: string;
  /** 刷新失败的说明；非空表示数值沿用上一次读数。 */
  stale: string;
}

const REASON = "不读取宿主令牌，账号额度不可用";

function unavailable(reason: string, source = "", account = ""): BalanceView {
  return {
    available: false,
    credit: null,
    credit_used: null,
    credit_unit: "积分",
    source,
    at: "",
    reason: reason.startsWith("无法获取") ? reason : `无法获取：${reason}`,
    account,
    stale: "",
  };
}

/**
 * 余额读数。
 *
 * 参数保留是为了不改调用方签名：任务根与读数无关，本实现不使用。
 */
export function balanceView(_root: string): BalanceView {
  if (process.env.CAPITALIST_USAGE_BALANCE === "0") {
    return unavailable("余额查询已关闭（CAPITALIST_USAGE_BALANCE=0）");
  }
  return unavailable(REASON);
}

/** 测试用：清缓存。当前实现无缓存，保留空函数以免调用方分支。 */
export function __resetBalance(): void {
  /* 无缓存可清。 */
}
