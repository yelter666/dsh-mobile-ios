// test/tunnel-login.mjs — 面板「重新授权（浏览器）」的状态机回归
//
// 现场（2026-11-21，Mac mini）：插件装好后点「开启远程」提示「登录的账号不对」，
// 而唯一能修好的动作是一条终端命令 `cloudflared tunnel login` —— 用户重装、重启、
// 点重置、点重新检测全试过，都没用（这些动作都不会换掉 cert.pem）。
//
// v0.2.19 起由插件自己起这条命令，面板只负责把链接摆出来并轮询结果。本套件锁：
//   ① 从 cloudflared 输出里捞授权链接（新旧输出格式都要能捞）；
//   ② 幂等：等待中重复点不会起第二个浏览器授权；
//   ③ 结论完整：退出码非 0 / 退出但没证书 / 超时 / 取消 / 启不起来，各自有可读原因；
//   ④ 不静默：错误信息保留 cloudflared 的最后几行，不是只留第一行；
//   ⑤ 只覆盖 HOME，证书一定落在本机真正使用的那份 ~/.cloudflared。

import { EventEmitter } from 'node:events';
import { createLoginManager } from '../src/cloudflared-login.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假子进程：真实 EventEmitter，测试自己决定什么时候吐输出/退出。 */
function fakeSpawn() {
  const calls = [];
  const spawn = (exe, args, opts) => {
    const child = new EventEmitter();
    child.pid = 5000 + calls.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = null;
    child.kill = (sig) => { child.killed = sig || 'SIGTERM'; };
    calls.push({ exe, args, opts, child });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

/** 可控 mtime 的 fs 桩：模拟 cert.pem 被覆盖（或根本没生成）。 */
function fakeFs(initialMtime) {
  let mtime = initialMtime;
  return {
    statSync: () => {
      if (mtime === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { mtimeMs: mtime };
    },
    renew: () => { mtime = (mtime || 0) + 1000; },
    remove: () => { mtime = null; },
  };
}

const URL_LINE = 'https://dash.cloudflare.com/argotunnel?aud=&callback=http%3A%2F%2Flocalhost%3A34567%2F';

console.log('\n1) 正常授权：捞链接 → 等退出 → 证书更新 → ok\n');
{
  const fsStub = fakeFs(1000);
  const spawn = fakeSpawn();
  const mgr = createLoginManager({ spawn, fsImpl: fsStub, log: () => {} });
  const started = mgr.start({ executable: '/opt/homebrew/bin/cloudflared', homeDir: '/tmp/dsh-login-home' });
  check('开始后进入 waiting', started.state === 'waiting', started.state);
  check('进程参数是 tunnel login', spawn.calls[0].args.join(' ') === 'tunnel login', spawn.calls[0].args.join(' '));
  check('只把 HOME 指到调用方给的目录（证书落点必须对）',
    spawn.calls[0].opts.env.HOME === '/tmp/dsh-login-home'
    && spawn.calls[0].opts.env.USERPROFILE === '/tmp/dsh-login-home',
    JSON.stringify({ HOME: spawn.calls[0].opts.env.HOME }));

  const child = spawn.calls[0].child;
  child.stderr.emit('data', 'Please open the following URL and log in with your Cloudflare account:\n\n');
  await sleep(5);
  check('链接还没打印时 url 为 null（面板显示「正在获取」）', mgr.status().url === null, String(mgr.status().url));
  child.stderr.emit('data', `${URL_LINE}\n\nLeave cloudflared running to download the cert automatically.\n`);
  await sleep(5);
  check('从输出里捞出授权链接', mgr.status().url === URL_LINE, String(mgr.status().url));
  check('等待中带提示语', /浏览器/.test(mgr.status().hint || ''), mgr.status().hint);

  fsStub.renew();
  child.emit('close', 0, null);
  const done = mgr.status();
  check('进程 0 退出且证书更新 → ok', done.state === 'ok', JSON.stringify(done));
  check('ok 后带完成时间', Boolean(done.finishedAt), String(done.finishedAt));
  check('ok 后不再显示「等待中」的提示', /授权完成/.test(done.hint || ''), done.hint);
}

console.log('\n2) 幂等：等待中重复点不会开第二个浏览器授权\n');
{
  const fsStub = fakeFs(1000);
  const spawn = fakeSpawn();
  const mgr = createLoginManager({ spawn, fsImpl: fsStub, log: () => {} });
  const a = mgr.start({ executable: 'cloudflared', homeDir: '/tmp/h' });
  const b = mgr.start({ executable: 'cloudflared', homeDir: '/tmp/h' });
  check('只起了一个 cloudflared', spawn.calls.length === 1, String(spawn.calls.length));
  check('两次调用拿到同一会话（同 pid）', a.pid === b.pid && a.startedAt === b.startedAt, `${a.pid}/${b.pid}`);
  mgr.cancel();
}

console.log('\n3) 失败路径：每种都要有可读原因，不能静默\n');
{
  // 3.1 退出码 0 但没有生成证书（最常见的「浏览器里没点授权」）
  const fsA = fakeFs(1000);
  const spawnA = fakeSpawn();
  const mgrA = createLoginManager({ spawn: spawnA, fsImpl: fsA, log: () => {} });
  mgrA.start({ executable: 'cloudflared', homeDir: '/tmp/h' });
  spawnA.calls[0].child.emit('close', 0, null);
  check('退出 0 但证书没更新 → error（不冒充成功）', mgrA.status().state === 'error', mgrA.status().state);
  check('并说明「没有生成 cert.pem」', /没有生成/.test(mgrA.status().error || ''), mgrA.status().error);

  // 3.2 退出码非 0：错误里必须保留最后几行原文（原来只留第一行 = 丢诊断）
  const fsB = fakeFs(1000);
  const spawnB = fakeSpawn();
  const mgrB = createLoginManager({ spawn: spawnB, fsImpl: fsB, log: () => {} });
  mgrB.start({ executable: 'cloudflared', homeDir: '/tmp/h' });
  spawnB.calls[0].child.stderr.emit('data', 'Getting User email from cert.pem\n');
  spawnB.calls[0].child.stderr.emit('data', 'ERR failed to fetch cert: code: 10000, reason: Authentication error\n');
  spawnB.calls[0].child.emit('close', 1, null);
  const failed = mgrB.status();
  check('退出码非 0 → error', failed.state === 'error', failed.state);
  check('错误里带退出码', /code 1/.test(failed.error || ''), failed.error);
  check('错误里保留真正的原因（不是只留第一行）', /Authentication error/.test(failed.error || ''), failed.error);

  // 3.3 超时：kill 掉等待中的进程，并说明超时
  const fsC = fakeFs(1000);
  const spawnC = fakeSpawn();
  const mgrC = createLoginManager({ spawn: spawnC, fsImpl: fsC, log: () => {}, timeoutMs: 30 });
  mgrC.start({ executable: 'cloudflared', homeDir: '/tmp/h' });
  await sleep(80);
  check('超时 → error', mgrC.status().state === 'error', mgrC.status().state);
  check('超时文案点明多少秒', /超时（0 秒）|超时/.test(mgrC.status().error || ''), mgrC.status().error);
  check('超时会 kill 子进程（不留孤儿）', spawnC.calls[0].child.killed === 'SIGTERM', String(spawnC.calls[0].child.killed));

  // 3.4 取消：kill + canceled；之后的 close 不得把状态改回 ok/error
  const fsD = fakeFs(1000);
  const spawnD = fakeSpawn();
  const mgrD = createLoginManager({ spawn: spawnD, fsImpl: fsD, log: () => {} });
  mgrD.start({ executable: 'cloudflared', homeDir: '/tmp/h' });
  const canceled = mgrD.cancel();
  check('取消 → canceled', canceled.state === 'canceled', canceled.state);
  check('取消会 kill 子进程', spawnD.calls[0].child.killed === 'SIGTERM', String(spawnD.calls[0].child.killed));
  spawnD.calls[0].child.emit('close', 0, null);
  check('取消后迟到的 close 不覆盖结论', mgrD.status().state === 'canceled', mgrD.status().state);

  // 3.5 启不起来（binary 不存在）
  const badSpawn = () => { throw Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' }); };
  const mgrE = createLoginManager({ spawn: badSpawn, fsImpl: fakeFs(1000), log: () => {} });
  const thrown = mgrE.start({ executable: '/nope/cloudflared', homeDir: '/tmp/h' });
  check('binary 不存在 → error 且说明起不来', thrown.state === 'error' && /无法启动/.test(thrown.error || ''), thrown.error);

  // 3.6 没给可执行文件：显式报错，交给面板提示先安装
  const mgrF = createLoginManager({ spawn: fakeSpawn(), fsImpl: fakeFs(1000), log: () => {} });
  let code = null;
  try { mgrF.start({ executable: null, homeDir: '/tmp/h' }); } catch (err) { code = err.code; }
  check('没有 cloudflared → NO_CLOUDFLARED（面板据此提示先安装）', code === 'NO_CLOUDFLARED', String(code));
}

console.log('\n4) idle 状态\n');
{
  const mgr = createLoginManager({ spawn: fakeSpawn(), fsImpl: fakeFs(1000), log: () => {} });
  const st = mgr.status();
  check('从未发起过 → idle 且字段齐全',
    st.state === 'idle' && st.url === null && st.error === null && st.hint === null, JSON.stringify(st));
}

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) process.exit(1);
