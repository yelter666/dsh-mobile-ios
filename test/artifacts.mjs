// artifacts.mjs 的断言：从会话事件还原产物清单。
//
// 这一层全是「事实判断」，所以断言也必须是事实：
// 真建临时目录、真写文件、真跑一次，而不是喂一堆假数据自证。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  deriveArtifacts, encodeArtifactId, decodeArtifactId, kindOf, mimeOf,
} from '../src/adapter/artifacts.mjs';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

const root = mkdtempSync(path.join(tmpdir(), 'dsh-artifacts-'));
const cwd = path.join(root, 'workspace');
mkdirSync(path.join(cwd, 'out'), { recursive: true });
writeFileSync(path.join(cwd, 'out', 'guide.md'), '# guide\n');
writeFileSync(path.join(cwd, 'out', 'chart.png'), Buffer.alloc(64, 7));
writeFileSync(path.join(cwd, 'read-only.md'), 'unchanged\n');
writeFileSync(path.join(root, 'outside.md'), 'not yours\n');

const call = (name, args, seq = 1, time = 1000) => ({
  event: { type: 'tool/call', seq, time, data: { name, arguments: args, callId: `c${seq}` } },
});

console.log('产物推导：');
check('写类工具 + 落盘文件 → 进清单', () => {
  const { items } = deriveArtifacts([call('Write', { file_path: 'out/guide.md' })], { cwd });
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'guide.md');
  assert.equal(items[0].kind, 'file');
});

check('只读工具（Read / Grep）不算产物', () => {
  const { items, skipped } = deriveArtifacts([
    call('Read', { file_path: 'out/guide.md' }),
    call('Grep', { path: 'out/guide.md' }),
  ], { cwd });
  assert.equal(items.length, 0, '只读工具带路径也不是产出');
  assert.equal(skipped.missing, undefined);
});

check('工作目录之外的文件被丢掉', () => {
  const { items, skipped } = deriveArtifacts([call('Write', { path: '../outside.md' })], { cwd });
  assert.equal(items.length, 0);
  assert.equal(skipped['outside-cwd'], 1);
});

check('绝对路径同样被收进 cwd', () => {
  const { items } = deriveArtifacts([call('Edit', { target_file: path.join(cwd, 'read-only.md') })], { cwd });
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'read-only.md');
});

check('文件不存在 → 不进清单（不留 404）', () => {
  const { items, skipped } = deriveArtifacts([call('Write', { file_path: 'out/ghost.md' })], { cwd });
  assert.equal(items.length, 0);
  assert.equal(skipped.missing, 1);
});

check('同一文件多次改写只留一条', () => {
  const { items } = deriveArtifacts([
    call('Write', { file_path: 'out/guide.md' }, 1, 1000),
    call('Edit', { file_path: 'out/guide.md' }, 2, 2000),
  ], { cwd });
  assert.equal(items.length, 1);
  assert.equal(items[0].updatedAt, new Date(2000).toISOString(), '以最后一次写入为准');
});

check('扩展名决定 kind 与 mime', () => {
  const { items } = deriveArtifacts([call('Write', { file_path: 'out/chart.png' })], { cwd });
  assert.equal(items[0].kind, 'image');
  assert.equal(items[0].mime, 'image/png');
});

check('arguments 是 JSON 字符串也能解', () => {
  const { items } = deriveArtifacts([
    call('create_file', JSON.stringify({ file_path: 'out/guide.md' })),
  ], { cwd });
  assert.equal(items.length, 1);
});

check('嵌套参数里的路径也能取到', () => {
  const { items } = deriveArtifacts([
    call('apply_patch', { edits: [{ path: 'out/guide.md' }] }),
  ], { cwd });
  assert.equal(items.length, 1);
});

check('没有 cwd 时如实返回空（不猜路径）', () => {
  const { items, skipped } = deriveArtifacts([call('Write', { file_path: 'out/guide.md' })], { cwd: null });
  assert.equal(items.length, 0);
  assert.equal(skipped['no-cwd'], 1);
});

console.log('产物 id：');
check('id 是相对路径，编解码往返一致', () => {
  const abs = path.join(cwd, 'out', 'guide.md');
  const id = encodeArtifactId(cwd, abs);
  assert.ok(!id.includes(cwd), 'id 不该带绝对路径');
  // 解码给的是**真实路径**（macOS 上 /var 是 /private/var 的软链），
  // 这一点要显式断言，否则测试会在别的系统上「看起来通过」。
  assert.equal(decodeArtifactId(cwd, id), realpathSync(abs));
});

check('解码结果只可能是 cwd 内的真实文件', () => {
  const forged = Buffer.from('../../outside.md', 'utf8').toString('base64url');
  assert.equal(decodeArtifactId(cwd, forged), null, '路径穿越必须被拒');
  assert.equal(decodeArtifactId(cwd, 'not-base64-!!'), null);
  assert.equal(decodeArtifactId(cwd, encodeArtifactId(cwd, path.join(root, 'outside.md'))), null);
});

check('kind / mime 映射覆盖常见后缀', () => {
  assert.equal(kindOf('.patch'), 'diff');
  assert.equal(kindOf('.log'), 'log');
  assert.equal(kindOf('.swift'), 'file');
  assert.equal(mimeOf('a.html'), 'text/html; charset=utf-8');
  assert.equal(mimeOf('a.bin'), 'application/octet-stream');
});


// 真实宿主的形状：name=run_code，写动作埋在 code 字符串里。
// 之前只认「写类工具名 + 参数键路径」，于是真机上产物永远为空——
// mock 夹具用的是 Write({file_path})，测试反而全绿。
check('run_code 里 tools.write 的路径算产物', () => {
  const code = 'await tools.write({ file_path: "out/guide.md", content: "# x" });';
  const { items } = deriveArtifacts([call('run_code', { code, description: 'write' })], { cwd });
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'guide.md');
});

check('run_code 里 tools.present 的文件算产物', () => {
  const code = 'await tools.present({ files: [{ path: "out/chart.png" }] });';
  const { items } = deriveArtifacts([call('run_code', { code })], { cwd });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'image');
});

check('run_code 里 tools.read 的路径不算产物（只读是输入）', () => {
  const code = 'const r = await tools.read({ file_path: "read-only.md" });';
  const { items } = deriveArtifacts([call('run_code', { code })], { cwd });
  assert.equal(items.length, 0);
});

check('Write 的 content 里出现的路径不当产物（只认参数键）', () => {
  const content = '示例：{ file_path: "out/chart.png" }';
  const { items } = deriveArtifacts([call('Write', { file_path: 'out/guide.md', content })], { cwd });
  assert.deepEqual(items.map((i) => i.name), ['guide.md']);
});

rmSync(root, { recursive: true, force: true });
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
