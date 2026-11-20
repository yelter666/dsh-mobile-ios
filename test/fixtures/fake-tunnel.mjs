// test/fixtures/fake-tunnel.mjs — 跨平台的假 cloudflared
//
// 为什么不用 .sh：Windows 的 CreateProcess 不能直接执行 shell 脚本，`spawn('*.sh')`
// 会得到 EFTYPE，隧道生命周期相关套件在 Windows 上直接崩掉（真实现场）。
// 用 Node 脚本 + 统一的 spawnImpl（node <本文件> <mode>）就能在 macOS/Linux/Windows
// 跑出完全一致的进程行为，kill / exit code / stdout 都真实发生。
//
// 模式：
//   ok     —— Quick Tunnel 正常输出（地址含 pid，保证每次启动都漂移）
//   named  —— 固定域名形态：只打注册成功那一行
//   silent —— 起了但永不吐地址（验证启动超时）
//   crash  —— 吐完地址 0.6s 后自行退出（验证自动重拉）

const mode = process.argv[2] || 'ok';
const say = (line) => process.stdout.write(`${line}\n`);

const keepAlive = () => {
  // 必须引用住事件循环：unref 会让子进程打印完就退出，被测代码会把「提前退出」
  // 当成崩溃/失败，测出来的超时时间与状态全是假的。
  setInterval(() => {}, 200);
  const bye = () => process.exit(0);
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
};

if (mode === 'ok') {
  say('2026-11-15T12:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so means...');
  say(`2026-11-15T12:00:01Z INF |  https://spike-${process.pid}.trycloudflare.com  |`);
  say('2026-11-15T12:00:02Z INF Registered tunnel connection connIndex=0 location=hkg06');
  keepAlive();
} else if (mode === 'named') {
  say('2026-11-18T00:00:00Z INF Starting tunnel tunnelID=fake-named-tunnel');
  say('2026-11-18T00:00:00Z INF Version 2026.11.1');
  say('2026-11-18T00:00:01Z INF Registered tunnel connection connIndex=0 connection=fake01 location=hkg01 protocol=quic');
  keepAlive();
} else if (mode === 'silent') {
  say('2026-11-15T12:00:00Z INF Starting tunnel, attempting to connect...');
  keepAlive();
} else if (mode === 'crash') {
  say(`2026-11-16T00:00:00Z INF |  https://crash-${process.pid}.trycloudflare.com  |`);
  say('2026-11-16T00:00:01Z INF Registered tunnel connection connIndex=0 location=hkg06');
  setTimeout(() => process.exit(1), 600);
} else {
  say(`unknown mode: ${mode}`);
  process.exit(64);
}
