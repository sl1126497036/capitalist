/** HTTP 小工具：发请求、解信封、任何情况下不抛。 */

const HTTP_TIMEOUT_MS = 20_000;

/** 服务端信封的通用形状。不同服务的字段含义不同，此处只约定 code / msg / data。 */
export interface Envelope {
  code: number;
  msg?: string;
  data?: unknown;
}

/**
 * 解服务端信封。
 *
 * 只认“对象且 code 是数字”这一种形状：合法 JSON 但形状不对（裸字符串、数组、
 * 网关的 `null`）同样按协议错误处理，并把原文前 200 字符带回，否则下游拿到
 * `code: undefined`，只能打印一句“code=undefined”，看不出响应到底是什么。
 *
 * @param fallbackCode 形状不符时使用的错误码。
 */
function parseEnvelope(text: string, fallbackCode: number): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 非 JSON 响应（网关错误页等）保留前 200 字符，便于定位
    return { code: fallbackCode, msg: text.slice(0, 200) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { code: fallbackCode, msg: `响应不是信封对象：${text.slice(0, 200)}` };
  }
  const env = parsed as Envelope;
  if (typeof env.code !== "number") {
    return { code: fallbackCode, msg: `信封缺 code 字段：${text.slice(0, 200)}` };
  }
  return env;
}

/**
 * 发送 JSON POST 请求并解析服务端信封。
 *
 * @param url 目标地址。
 * @param headers 合并进默认请求头。
 * @param body 已序列化的请求体。
 * @returns 服务端信封。网络异常或超时时返回 `code: -1`，不抛。
 */
export async function postJson(
  url: string,
  headers: Record<string, string> = {},
  body: string = "{}",
): Promise<Envelope> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return parseEnvelope(await res.text(), res.status);
  } catch (err) {
    return { code: -1, msg: String((err as Error).message ?? err) };
  }
}

/**
 * 发送 JSON GET 请求并解析服务端信封。
 *
 * @param url 目标地址。
 * @param headers 合并进默认请求头。
 * @returns 服务端信封。网络异常或超时时返回 `code: -1`，不抛。
 */
export async function getJson(url: string, headers: Record<string, string> = {}): Promise<Envelope> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return parseEnvelope(await res.text(), res.status);
  } catch (err) {
    return { code: -1, msg: String((err as Error).message ?? err) };
  }
}
