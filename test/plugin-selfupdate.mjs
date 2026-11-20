// test/plugin-selfupdate.mjs — 网关侧插件自更新（不依赖宿主 pluginManager）
//
// 背景：宿主拿不到 remote.pluginManager 时，老实现只剩「复制包名 → 去插件页粘贴」，
// 而 dsh-app:// 页面里剪贴板本身也不可用，于是「一键更新」与「复制」同时失效。
// 这里锁住网关自更新的契约：shasum 校验、版本核对、备份、幂等、失败不落盘。
// 全程注入 fetch/exec，不联网、不解真包。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { selfUpdatePlugin, PLUGIN_NAME } from '../src/plugin-update.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-selfupdate-'));
const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');
// 必须 >1024 字节，否则会被「下载内容异常」挡下
const TARBALL = Buffer.alloc(2048, 7);

function makeRoot(version) {
  const root = fs.mkdtempSync(path.join(tmp, 'root-'));
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: PLUGIN_NAME, version }));
  fs.writeFileSync(path.join(root, 'lib', 'client.js'), '// old build\n');
  return root;
}

/** 假 fetch：元数据 + tarball；sum 可覆盖以模拟校验失败。 */
function fakeFetch({ version = '0.2.9', shasum = sha1(TARBALL) } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    if (String(url).includes(`${PLUGIN_NAME}`) && !String(url).endsWith('.tgz')) {
      return {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: version },
          versions: { [version]: { dist: { tarball: 'https://registry.example.test/pkg.tgz', shasum } } },
        }),
      };
    }
    if (String(url).endsWith('.tgz')) return { ok: true, arrayBuffer: async () => TARBALL };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  impl.calls = calls;
  return impl;
}

/** 假解包：在 tar 的 -C 目录下造出 package/，模拟真实 tarball 结构。 */
function fakeExec(version) {
  return async (cmd, args) => {
    const i = args.indexOf('-C');
    const dir = args[i + 1];
    const pkg = path.join(dir, 'package');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: PLUGIN_NAME, version }));
    fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'lib', 'client.js'), '// new build\n');
  };
}

console.log('\n网关自更新\n');

// 1. 正常升级：覆盖安装、备份旧目录、声明需重启
{
  const root = makeRoot('0.2.8');
  const res = await selfUpdatePlugin({
    pluginRoot: root, fetchImpl: fakeFetch(), execImpl: fakeExec('0.2.9'),
  });
  check('升级成功 ok=true', res.ok === true);
  check('from/to 如实回报', res.from === '0.2.8' && res.to === '0.2.9');
  check('changed=true', res.changed === true);
  check('安装目录版本已更新', JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version === '0.2.9');
  check('插件代码确实被替换', fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8').includes('new build'));
  check('声明需要重启才生效', res.restartRequired === true);
  check('旧目录已备份', Boolean(res.backup) && fs.existsSync(res.backup));
  check('备份里是旧版本', JSON.parse(fs.readFileSync(path.join(res.backup, 'package.json'), 'utf8')).version === '0.2.8');
}

// 2. 完整性校验失败：必须中止，且一个字节都不能落盘
{
  const root = makeRoot('0.2.8');
  let err = null;
  try {
    await selfUpdatePlugin({ pluginRoot: root, fetchImpl: fakeFetch({ shasum: 'deadbeef' }), execImpl: fakeExec('0.2.9') });
  } catch (e) { err = e; }
  check('校验失败抛错', Boolean(err));
  check('错误点明完整性校验', /完整性校验失败/.test(err?.message || ''));
  check('失败后版本未被改动', JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version === '0.2.8');
  check('失败后无备份残留目录', fs.readdirSync(path.dirname(root)).every((n) => !n.startsWith(`.${PLUGIN_NAME}.backup-`)));
}

// 3. 已是目标版本：幂等返回，不重复下载安装
{
  const root = makeRoot('0.2.9');
  const probe = fakeFetch({ version: '0.2.9' });
  const res = await selfUpdatePlugin({ pluginRoot: root, fetchImpl: probe, execImpl: fakeExec('0.2.9') });
  check('同版本 changed=false', res.changed === false);
  check('同版本不产生备份', res.backup === null);
  check('同版本不需要重启', res.restartRequired === false);
  check('同版本不下载 tarball', !probe.calls.some((u) => u.endsWith('.tgz')));
}

// 4. registry 全不可达：如实报错，不能假装成功
{
  const root = makeRoot('0.2.8');
  let err = null;
  try {
    await selfUpdatePlugin({
      pluginRoot: root,
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      execImpl: fakeExec('0.2.9'),
    });
  } catch (e) { err = e; }
  check('源不可达时抛错', Boolean(err));
  check('错误提示无法获取版本信息', /无法获取版本信息/.test(err?.message || ''));
}

// 5. 解包版本与元数据不一致：拒绝覆盖（防投毒/错包）
{
  const root = makeRoot('0.2.8');
  let err = null;
  try {
    await selfUpdatePlugin({ pluginRoot: root, fetchImpl: fakeFetch({ version: '0.2.9' }), execImpl: fakeExec('9.9.9') });
  } catch (e) { err = e; }
  check('解包版本不符时抛错', Boolean(err));
  check('错误点明解包版本不符', /解包版本不符/.test(err?.message || ''));
  check('不符时原版本保持不动', JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version === '0.2.8');
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败\n`);
if (failures.length) process.exit(1);
