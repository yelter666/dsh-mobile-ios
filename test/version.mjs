// test/version.mjs — 版本号一致性回归（防止 0.2.1/0.2.2 漂移事故重演）
//
// 事故：package.json 发版到 0.2.2，但 rest.mjs 的 GATEWAY_VERSION 与 plugin.mjs
// 的 version 硬编码停在 0.2.1 —— 详情显示 v0.2.2、面板显示 v0.2.1、更新检查
// 拿 0.2.1 比对 npm latest 0.2.2 误报「发现新版」。
// 本套件断言四处版本同源：package.json / version.mjs / summary 端点 / 插件 export。

import { createRequire } from 'node:module';
import { PLUGIN_VERSION } from '../src/version.mjs';
import { createGateway } from '../src/server.mjs';
import { createMockHost } from '../src/adapter/mock-host.mjs';
import { httpJson } from './lib/wsclient.mjs';

const require = createRequire(import.meta.url);
const pkgVersion = require('../package.json').version;

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\n版本号一致性回归\n');

// 1. 单一真相源与包元数据一致
check('version.mjs 与 package.json 同版本', PLUGIN_VERSION === pkgVersion, `${PLUGIN_VERSION} vs ${pkgVersion}`);

// 2. 插件 export 的 version 与真相源一致（插件详情走这里）
const pluginMod = await import('../entries/plugin.mjs');
check('plugin.mjs export version 与真相源一致', pluginMod.version === PLUGIN_VERSION, `${pluginMod.version} vs ${PLUGIN_VERSION}`);

// 3. summary 端点下发的版本（面板「插件版本」+ 更新检查的 current）与真相源一致
const PORT = Number(process.env.VERSION_TEST_PORT || 3391);
const gw = await createGateway({ host: createMockHost({}), port: PORT, dev: true });
await gw.start();
try {
  const summary = await httpJson({ port: PORT, path: '/mobile/v1/desktop/summary' });
  check('desktop/summary 可达', summary.status === 200);
  check('summary.version 与 package.json 同版本', summary.body?.version === pkgVersion, `${summary.body?.version} vs ${pkgVersion}`);
} finally {
  await gw.stop();
}

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败\n`);
if (failures.length) process.exitCode = 1;
