// tunnel-error.mjs — 把 cloudflared 的失败翻译成「用户能照做」的一句话 + 一条命令
//
// 事故现场（2026-11-21）：`cloudflared tunnel route dns` 失败时，
// provision-local 只取 stderr 第一行（`Command failed: /opt/homebrew/bin/cloudflared …`），
// 真正的原因在第二行 `Failed to add route: code: 10000, reason: Authentication error`，
// 被 `split('\n')[0]` 直接丢掉；detail 又固定写「确认域名在当前账号下」。
// 用户在面板上看到的是一句命令回显 —— 既不知道是账号问题，也不知道接下来做什么。
//
// 这里做两件事：
//   1. **如实保留** cloudflared 的错误码与原因（code / reason），不截断；
//   2. 按错误语义给出**对应的**修法。特别是「账号/域名不匹配」这一类，
//      唯一正确的动作是用持有该域名的账号重跑 `cloudflared tunnel login`，
//      重装插件、改 NS、重启宿主都无效——这一点必须写在提示里。

/** codeflared 的错误码含义（只收录会被我们误判成「网络问题」的几种）。 */
const CREDENTIAL_CODES = new Set([10000, 1001, 1003, 1004, 9109]);

/**
 * 解析 cloudflared 的失败文本。
 * @returns {{ code: number|null, reason: string|null, first: string, stderr: string }}
 */
export function parseCloudflaredFailure(input) {
  const text = String(input ?? '');
  // 形如：Failed to add route: code: 10000, reason: Authentication error
  const m = /code:\s*(\d{3,6})\s*,\s*reason:\s*([^\n\r]+)/i.exec(text);
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const first = lines[0] || '';
  return {
    code: m ? Number(m[1]) : null,
    reason: m ? m[2].trim() : null,
    first,
    // 保留完整文本供 detail 使用（面板/日志需要原始证据，不做二次截断）
    stderr: text.trim(),
  };
}

/** cloudflared 的失败文本里有没有「凭据/权限」语义。 */
function looksLikeCredentialIssue(text) {
  return /authentication error|invalid zone identifier|unauthorized|forbidden|permission|not authorized|403/i.test(text);
}

function looksLikeZoneIssue(text) {
  return /zone not found|invalid zone|no zone|zone does not exist|1001/i.test(text);
}

/**
 * 生成可直接展示的错误。
 *
 * @param {unknown} err    route/create 抛出的异常
 * @param {object} opts
 * @param {string} opts.baseDomain  固定地址所用域名（提示里要指名道姓）
 * @param {'route-dns'|'create-tunnel'} [opts.operation] 失败发生在哪一步
 * @param {string|null} [opts.accountName] 当前证书所属账号（已知时写进提示）
 * @param {string|null} [opts.exe] 实际使用的 cloudflared 路径/名字
 * @returns {{ message: string, detail: string, reason: string, code: number|null }}
 */
export function explainTunnelFailure(err, { baseDomain = 'matrixboard.cn', operation = 'route-dns', accountName = null, exe = 'cloudflared' } = {}) {
  const parsed = parseCloudflaredFailure(err?.message || err);
  const raw = parsed.stderr || parsed.first;
  const codeText = parsed.code !== null ? `code: ${parsed.code}${parsed.reason ? `, reason: ${parsed.reason}` : ''}` : null;
  const accountText = accountName ? `（当前证书属于 ${accountName}）` : '';
  const loginHint = `请在这台电脑的终端执行：${exe} tunnel login`
    + `，在浏览器里选择持有 ${baseDomain} 的账号完成授权（会覆盖 ~/.cloudflared/cert.pem），`
    + '然后回到面板点「开启远程」重试。重装插件或重启宿主都不能替代这一步。';

  if ((parsed.code !== null && CREDENTIAL_CODES.has(parsed.code)) || looksLikeCredentialIssue(raw)) {
    return {
      message: `Cloudflare 拒绝了写入：当前账号没有 ${baseDomain} 的权限`,
      detail: `${loginHint}${codeText ? ` cloudflared 返回 ${codeText}。` : ''}${accountText}`,
      reason: 'credentials',
      code: parsed.code,
    };
  }
  if (looksLikeZoneIssue(raw)) {
    return {
      // 保留 cloudflared 的原文（排障要用），同时把结论写在前面（用户要能一眼看懂）
      message: `域名 ${baseDomain} 不在当前登录的 Cloudflare 账号下（${parsed.reason || parsed.first}）`,
      detail: `cloudflared 返回：${raw || 'zone not found'}。${loginHint}`,
      reason: 'zone',
      code: parsed.code,
    };
  }
  const action = operation === 'create-tunnel' ? '创建隧道' : '写入 DNS';
  return {
    message: `${action}失败：${parsed.first || 'cloudflared 未给出原因'}`,
    detail: `cloudflared 返回：${raw || '(空)'}`
      + `。若反复失败，请执行 ${exe} tunnel login 重新授权 ${baseDomain} 后再试。`,
    reason: 'unknown',
    code: parsed.code,
  };
}
