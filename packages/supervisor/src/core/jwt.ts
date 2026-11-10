/**
 * JWT 载荷读取。
 *
 * 只解析中段声明，不验签：信任判断由服务端做，本机只用于对账与展示。
 */

/**
 * 解码 JWT 中段载荷，不验签。
 *
 * 仅读取 `payload` 段的声明（主体、过期时间等），用于本机对账与展示；信任判定由服务端完成。
 *
 * @param token JWT 字符串。
 * @returns 载荷对象。输入缺段、非 base64 或非法 JSON 时返回空对象，不抛。
 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1];
    if (!part) return {};
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
