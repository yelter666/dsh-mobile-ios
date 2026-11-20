// test/lib/fake-tunnel.mjs — 假 cloudflared 的统一装配
//
// 用法：
//   const fake = fakeTunnel('ok');
//   new TunnelManager({ executable: fake.executable, spawnImpl: fake.spawnImpl })
//
// executable 指向一个真实存在的文件（findCloudflared 的存在性检查要用），
// spawnImpl 把它换成 `node <script> <mode>` —— 三个平台行为一致，不依赖 shell。

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
