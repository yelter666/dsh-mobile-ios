// test/resilience.mjs — S-1 韧性验收：三类故障必须「可编程复现」
//
// 为什么单独一套：selftest 验的是「功能对不对」，这里验的是「坏了以后能不能自证」。
// 三个场景对应 PRD §12.1 的验收项，也是 iOS 侧状态机唯一能拿到的真实输入：
//   R1 链路中断   → 重连后按游标补帧，零丢失零重复
//   R2 seq 缺口   → 明确标记 gap，而不是静默少数据
//   R3 宿主重启   → gen 变化 + 主动告知；客户端必须全量重建
//
// 跑法：cd gateway && node test/resilience.mjs

import { createGateway } from '../src/server.mjs';
import { createMockHost } from '../src/adapter/mock-host.mjs';
import { connect, httpJson } from './lib/wsclient.mjs';

const PORT = Number(process.env.PORT || 3381);
const TASK = 'tsk_a41f9c';
const INSTALL = 'ins_resilience';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const host = createMockHost();
const gw = await createGateway({ host, port: PORT, dev: true, log: () => {} });
const { port } = await gw.start();
console.log(`\n韧性验收 @ 127.0.0.1:${port}\n`);

// ---- 准备：配对拿凭证 ----
const codeRes = await httpJson({ port, method: 'POST', path: '/mobile/v1/pairing/code', body: { deviceName: 'resilience' } });
const redeem = await httpJson({
  port,
  method: 'POST',
  path: '/mobile/v1/pairing/redeem',
  body: { code: codeRes.body.code, installId: INSTALL, deviceName: 'resilience', platform: 'ios', appVersion: 'test' },
});
const token = redeem.body?.deviceToken;
const deviceId = redeem.body?.deviceId;
if (!token) {
  console.error('配对失败，无法继续：', JSON.stringify(redeem.body));
  process.exit(1);
}

const auth = { Authorization: `Bearer ${token}` };
const emit = async (data) => {
  const r = await httpJson({ port, method: 'POST', path: '/__mock/emit', body: { taskId: TASK, kind: 'log', data } });
  return r.body?.emitted;
};
const open = () => connect({ port, headers: auth });
const hello = (ws, extra = {}) => ws.send({ t: 'hello', protocolVersion: '1.0', caps: [], deviceId, installId: INSTALL, ...extra });

async function collect(ws, n, timeout = 3000) {
  const out = [];
  while (out.length < n) {
    const { json } = await ws.next(timeout);
    if (json?.t === 'ev') out.push(json);
  }
  return out;
}

// ============ R1 链路中断：按游标续传，零丢帧 ============
console.log('R1 链路中断与续传');
const c1 = await open();
hello(c1);
const ready1 = await c1.until((j) => j?.t === 'ready');
check('首连 ready', ready1.json?.t === 'ready' && Boolean(ready1.json?.gen));

for (let i = 1; i <= 5; i += 1) await emit({ line: `L${i}` });
const first5 = await collect(c1, 5);
const seqs5 = first5.map((f) => f.seq);
check('在线收到 5 帧且 seq 连续 1..5', seqs5.join(',') === '1,2,3,4,5', seqs5.join(','));

// 模拟断网：不发 close 帧，直接掐 socket
const dropRes = await httpJson({ port, method: 'POST', path: '/__mock/drop' });
check('链路中断注入生效', dropRes.status === 200 && dropRes.body?.dropped >= 1, JSON.stringify(dropRes.body));
const abrupt = await c1.waitClose(3000).catch(() => ({ code: 'timeout' }));
check('客户端观察到异常断开（非优雅关闭，无 1012/1001）', abrupt?.code !== 1012 && abrupt?.code !== 1001, String(abrupt?.code));

// 离线期间宿主继续产出
await emit({ line: 'L6' });
await emit({ line: 'L7' });

const c2 = await open();
hello(c2, { lastSeq: 5 });
const ready2 = await c2.until((j) => j?.t === 'ready');
check('重连 resumeFrom=6（不从头补）', ready2.json?.resumeFrom === 6, String(ready2.json?.resumeFrom));
check('resumed=2（只补离线期间的 2 帧）', ready2.json?.resumed === 2, String(ready2.json?.resumed));
check('重连无 gap 标记（游标仍在缓冲内）', ready2.json?.gap === false, String(ready2.json?.gap));
const back2 = await collect(c2, 2);
check('补帧 seq 为 6,7，无重复', back2.map((f) => f.seq).join(',') === '6,7', back2.map((f) => f.seq).join(','));
const dup = new Set([...seqs5, ...back2.map((f) => f.seq)]).size;
check('1..7 共 7 个唯一 seq（零丢失零重复）', dup === 7, String(dup));
c2.close();

// ============ R2 seq 缺口：必须显式标记 ============
console.log('\nR2 缓冲缺口');
const gapRes = await httpJson({ port, method: 'POST', path: '/__mock/gap', body: { taskId: TASK, keep: 2 } });
check('缺口注入：裁掉旧帧', gapRes.body?.dropped === 5, JSON.stringify(gapRes.body));
check('下界升到 6', gapRes.body?.lowerBound === 6, String(gapRes.body?.lowerBound));

const c3 = await open();
hello(c3, { lastSeq: 1 });
const ready3 = await c3.until((j) => j?.t === 'ready');
check('游标早于下界 → gap=true（不静默少数据）', ready3.json?.gap === true, String(ready3.json?.gap));
check('resumeFrom 指向真实下界 6，不是 1', ready3.json?.resumeFrom === 6, String(ready3.json?.resumeFrom));
const back3 = await collect(c3, 2);
check('只补得到的 6,7', back3.map((f) => f.seq).join(',') === '6,7', back3.map((f) => f.seq).join(','));
c3.close();

// ============ R3 宿主重启：gen 换 + 主动告知 + 全量重建 ============
console.log('\nR3 宿主重启');
const c4 = await open();
hello(c4);
const ready4 = await c4.until((j) => j?.t === 'ready');
const oldGen = ready4.json?.gen;
check('重启前 ready 带 gen', typeof oldGen === 'string' && oldGen.startsWith('gen_'));

const restart = await httpJson({ port, method: 'POST', path: '/__mock/restart-host', body: { reason: 'test' } });
check('重启后 gen 已更换', restart.body?.gen !== oldGen, `${oldGen} → ${restart.body?.gen}`);

const notice = await c4.until((j) => j?.t === 'ev' && j?.kind === 'gateway', 3000).catch(() => null);
// 字段名必须是 event（契约 §4.5）。实现曾发 type，客户端按契约读 event，
// 结果事件被静默丢弃、只剩 1012 兜底——这条断言就是防它再退回去。
check('在线客户端收到 gateway 事件（字段名 event）',
  notice?.json?.data?.event === 'host.restarted' && notice?.json?.data?.type === undefined,
  JSON.stringify(notice?.json?.data));
check('gateway 事件带新旧 gen（可自证）', notice?.json?.data?.gen === restart.body?.gen && notice?.json?.data?.prevGen === oldGen);
const closeCode = await c4.waitClose(3000).catch(() => ({ code: null }));
check('随后以 1012（服务重启）关闭', closeCode?.code === 1012, String(closeCode?.code));

// 客户端拿着旧 gen 回来：必须被要求全量重建，而不是「补不到 = 没新事件」
const c5 = await open();
hello(c5, { gen: oldGen, lastSeq: 7 });
const ready5 = await c5.until((j) => j?.t === 'ready');
check('旧 gen 握手 → genChanged=true', ready5.json?.genChanged === true, JSON.stringify({ gen: ready5.json?.gen, genChanged: ready5.json?.genChanged }));
check('旧 gen 握手 → gap=true（强制全量重建）', ready5.json?.gap === true, String(ready5.json?.gap));
check('旧 gen 握手 → resumed=0（不假装续传）', ready5.json?.resumed === 0, String(ready5.json?.resumed));
c5.close();

// 新 gen 回来：正常，不应误报 gap
const c6 = await open();
hello(c6, { gen: restart.body?.gen });
const ready6 = await c6.until((j) => j?.t === 'ready');
check('新 gen 握手 → gap=false（不误判）', ready6.json?.gap === false, String(ready6.json?.gap));
check('新 gen 与网关一致', ready6.json?.gen === restart.body?.gen);

// 重启后 seq 从 1 重新开始（新代际新空间）
const afterRestart = await emit({ line: 'after-restart' });
check('重启后 seq 重新从 1 开始', afterRestart?.seq === 1, String(afterRestart?.seq));
await collect(c6, 1);
c6.close();

// ============ R4 幂等不随重启失效 ============
console.log('\nR4 幂等与重启的交互');
const sub = 'sub_resilience_001';
const create1 = await httpJson({ port, method: 'POST', path: '/mobile/v1/tasks', token, body: { prompt: '跑一遍回归', submissionId: sub } });
check('首次建任务 duplicate=false', create1.status === 202 && create1.body?.duplicate === false, JSON.stringify(create1.body?.duplicate));
const create2 = await httpJson({ port, method: 'POST', path: '/mobile/v1/tasks', token, body: { prompt: '跑一遍回归', submissionId: sub } });
check('同键重发 duplicate=true（契约要求，不重复下发）', create2.body?.duplicate === true, JSON.stringify(create2.body?.duplicate));
check('同时带 replayed 标记（日志可追溯）', create2.body?.replayed === true, String(create2.body?.replayed));
check('重发回到同一 taskId', create2.body?.taskId === create1.body?.taskId, `${create1.body?.taskId} vs ${create2.body?.taskId}`);

// ---- 收尾 ----
await gw.stop?.().catch?.(() => {});
console.log(`\n结果：${pass} 通过 / ${failures.length} 失败\n`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f.name} — ${f.detail}`);
  process.exit(1);
}
process.exit(0);
