// protocol.mjs — 契约 v0.2 的常量与错误码表
// 原则：错误码只增不改；客户端按 code 分流，不按 message 文本匹配。

export const PROTOCOL_VERSION = '1.0';
export const PROTOCOL_MAJOR_SUPPORTED = [1];

export const EV_KINDS = ['state', 'log', 'turn', 'todo', 'artifact', 'gateway'];
// idle：宿主里会话存在、但没有在跑任何回合（可以继续说话）。
// 与 interrupted 的区别是「我们没有理由说它被打断过」——见 cordis-host.mjs 的映射说明。
export const TASK_STATUS = ['running', 'needsYou', 'done', 'failed', 'idle', 'interrupted', 'cancelled'];

/**
 * 错误码表。
 * http：REST 场景返回的 HTTP 状态；wsClose：WS 场景的关闭码（null 表示不关连接）。
 * retry：客户端是否应退避重试（false 表示"不要重试，按文案引导用户"）。
 */
export const ERRORS = {
  4001: { message: '凭证已失效，请重新配对', http: 401, retry: false, action: 'needsPairing' },
  4003: { message: '这台主机不信任当前地址', http: 403, retry: false, action: 'rePair' },
  4004: { message: '协议版本不兼容，请更新主机端', http: 400, retry: false, action: 'readOnly' },
  4007: { message: '主机忙，稍后重试', http: 503, retry: true, action: 'backoff' },
  4008: { message: '配对码已过期或错误', http: 400, retry: false, action: 'rePair' },
  4009: { message: '这台设备已被撤销', http: 401, retry: false, action: 'clearCredential' },
  4010: { message: '待办已过期', http: 409, retry: false, action: 'grayOut' },
  4011: { message: '任务不存在', http: 404, retry: false, action: 'interrupted' },
  4021: { message: '当前主机不支持该方法', http: 501, retry: false, action: 'hideControl' },
  4029: { message: '操作过于频繁', http: 429, retry: true, action: 'backoff' },
  4400: { message: '请求参数不合法', http: 400, retry: false, action: 'fixRequest' },
  4404: { message: '接口不存在', http: 404, retry: false, action: 'fixRequest' },
  4500: { message: '主机内部错误', http: 500, retry: true, action: 'backoff' },
};

export class GatewayError extends Error {
  constructor(code, message, extra = {}) {
    super(message || ERRORS[code]?.message || 'UNKNOWN');
    this.code = code;
    this.extra = extra;
  }
  toJSON() {
    return { code: this.code, message: this.message, ...this.extra };
  }
}

export const fail = (code, message, extra) => new GatewayError(code, message, extra);

export function newId(prefix) {
  // 只用于内部 id（ticket / 连接 id / 设备 id），不需要密码学强度之外的特性
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export function majorOf(version) {
  const n = Number.parseInt(String(version || '').split('.')[0], 10);
  return Number.isFinite(n) ? n : NaN;
}

export function isSupportedProtocol(version) {
  return PROTOCOL_MAJOR_SUPPORTED.includes(majorOf(version));
}
