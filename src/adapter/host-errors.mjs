// adapter/host-errors.mjs — 宿主 RemoteError → 协议错误码的唯一映射处
//
// 为什么单独成文件（2026-11-22）：这份映射是**整条写链路的刹车**。
// 真机事故里 `session/attachment-invalid` 没进映射表，兜底 4500（= 可重试），
// 客户端按退避无限重放同一个 submissionId，于是队首永不放手、后面所有发送全堵死。
// 映射规则必须能被命令行断言覆盖，而不是埋在 cordis 适配器里只能靠真机试。

import { fail } from '../protocol.mjs';

// 宿主 RemoteError.code → 我们的协议错误码。
// 宿主码来自 dsh-typert-protocol / 各控制器源码（gateway/bad-request、
// session/not-found、session/agent-busy、workspace/not-found 等）。
export const HOST_CODE_MAP = {
  'session/not-found': 4011,
  'workspace/not-found': 4011,
  'session/agent-busy': 4007,
  'session/wait-timeout': 4007,
  'gateway/bad-request': 4400,
  'gateway/internal': 4500,
  'gateway/signature-invalid': 4400,
  'gateway/context-unavailable': 4021,
  // 2026-11-22 真机事故（日志实证 247 次重放）：
  // `session/attachment-invalid` 此前没进映射表 → 落到兜底 4500（= 可重试），
  // 客户端按退避无限重放**同一个 submissionId**。后果是连锁的：
  //   1) 队首永不放手（WriteQueue 保序），后面所有 appendMessage 全被堵住
  //      → 历史会话「发不出去、只有 3 条待发送」；
  //   2) createTask 每次重试都会**再建一个空会话**（宿主 create 成功、prompt 被拒）
  //      → 侧栏被空占位刷屏，而用户看到的是「新建毫无反应」。
  // 这是确定性失败（模型不支持图片 / 图片超限 / receipt 失效），不可重试：
  // 归 4400（fixRequest），文案直接告诉用户下一步怎么改。
  'session/attachment-invalid': 4400,
  'session/model-unavailable': 4400,
};

/**
 * 附件被宿主拒绝时，把宿主 reason 翻成一句能行动的中文。
 *
 * reason 的取值来自宿主 `RemoteErrorDetailsMap['session/attachment-invalid']`
 * （app.asar 实证：`{ reason: string }`），常见的几个：
 *   · MODEL_DOES_NOT_SUPPORT_IMAGES —— 当前模型不接受图片输入（新建会话跟电脑端默认走）；
 *   · IMAGES_TOO_LARGE / TOO_MANY_IMAGES —— 图片总体积 / 张数超限；
 *   · FILE_TOO_LARGE / FILE_EMPTY / INVALID_BASE64 —— 通用文件那一侧被拒。
 * 认不出来也要把 reason 原样带上：排查时不能只剩一句「附件无效」。
 */
export function attachmentRejectionMessage(reason) {
  switch (String(reason || '')) {
    case 'MODEL_DOES_NOT_SUPPORT_IMAGES':
      return '这个模型不接受图片输入 — 换成支持图片的模型，或去掉图片再发。';
    case 'IMAGES_TOO_LARGE':
      return '图片总量超过电脑端限额 — 少选几张，或换小一点的原图再发。';
    case 'TOO_MANY_IMAGES':
      return '图片张数超过电脑端限额 — 少选几张再发。';
    case 'FILE_TOO_LARGE':
      return '文件超过电脑端限额 — 换小一点的文件再发。';
    default:
      return reason
        ? `附件被电脑端拒绝（${reason}）— 去掉附件或换一张再试。`
        : '附件被电脑端拒绝 — 去掉附件或换一张再试。';
  }
}

export function isHostRemoteError(err) {
  return err && typeof err === 'object' && err.isDSHRemoteError === true;
}

/**
 * 翻译一个宿主错误。
 *
 * 宿主 `details` 带着机器可读原因（zod details 对象，例如
 * `{ reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' }`）。此前整块丢掉，日志里只剩一个
 * `4500`，谁也没法判断到底是「附件坏了」还是「模型不吃图片」。
 */
export function toGatewayError(err, method) {
  if (isHostRemoteError(err)) {
    const code = HOST_CODE_MAP[err.code] ?? 4500;
    const reason = typeof err.details?.reason === 'string' ? err.details.reason : '';
    const message = err.code === 'session/attachment-invalid'
      ? attachmentRejectionMessage(reason)
      : (err.code === 'session/model-unavailable'
        ? '这台电脑当前没有可用模型 — 请在电脑端选一个模型（或清掉手机上新任务选的模型）后再发。'
        : (code === 4500 ? `宿主错误：${err.code}` : undefined));
    return fail(code, message, {
      detail: `host=${err.code} method=${method}${reason ? ` reason=${reason}` : ''}`,
      hostCode: err.code,
      ...(reason ? { reason } : {}),
    });
  }
  return fail(4500, '宿主调用异常', {
    detail: `method=${method} ${err?.name || 'Error'}: ${err?.message || String(err)}`,
  });
}
