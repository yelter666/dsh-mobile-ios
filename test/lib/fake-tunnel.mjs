// test/lib/fake-tunnel.mjs — 假 cloudflared 的统一装配
//
// 用法：
//   const fake = fakeTunnel('ok');
//   new TunnelManager({ executable: fake.executable, spawnImpl: fake.spawnImpl })
//
// executable 指向一个真实存在的文件（findCloudflared 的存在性检查要用），
// spawnImpl 把它换成 `node <script> <mode>` —— 三个平台行为一致，不依赖 shell。
//
// 跨平台注意（2026-11-21 macOS 实测）：`findCloudflared` 对显式路径要求
// `accessSync(path, X_OK)` 通过。Windows 上 X_OK 退化为「存在」，所以
// fixtures/fake-tunnel.mjs 有没有执行位都无所谓；macOS/Linux 上 0644 会直接
// 判「主机未安装 cloudflared」，ops.mjs 在第三条断言就抛 4021。
// 该 fixture 必须以 **100755** 入库（git ls-files -s 可见），别在编辑器里另存回 644。

import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_SCRIPT = path.join(HERE, '..', 'fixtures', 'fake-tunnel.mjs');

export function fakeTunnel(kind = 'ok') {
  return {
    kind,
    executable: FAKE_SCRIPT,
    spawnImpl: (exe, args, opts = {}) => nodeSpawn(process.execPath, [FAKE_SCRIPT, kind], {
      stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
      env: opts.env,
      windowsHide: true,
    }),
  };
}
