// test/dns-recheck.mjs — 「域名解析异常」自锁死的回归测试
//
// 故障：dnsOk=false 会被写进状态文件，面板据此禁用「开启远程」按钮，
// 而唯一的重探入口就在开启流程里 —— 按钮点不到就永远不重探，
// 用户把 NS 改对之后也只能看到「解析异常，暂不可开启」，非删状态文件不可恢复。
// 本套件锁住两件事：① 有一条不问缓存、强制重探的路径；② 重探结论会写回状态，
// 通过后 status() 立刻反映 dnsOk=true（面板据此恢复可点）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalProvisioner } from '../src/provision-local.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const TUNNEL_ID = 'af2f69b3-8e13-4a85-aca9-5ff8cc7d489f';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dns-recheck-'));

function seedState(dir, over = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, 'tunnel-named.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1,
    installationId: 'abc',
    subdomain: 'dsh-test',
    hostname: 'dsh-test.matrixboard.cn',
    tunnelId: TUNNEL_ID,
    credentialsFile: path.join(dir, 'cred.json'),
    configFile: path.join(dir, 'tunnel-config.yml'),
    port: 3081,
    dnsOk: false,
    dnsTampered: false,
    dnsCheckedAt: '2026-11-20T00:00:00.000Z',
    createdAt: '2026-11-20T00:00:00.000Z',
    ...over,
  }));
  return stateFile;
}

function makeProvisioner(stateFile, probe) {
  const dir = path.dirname(stateFile);
  return new LocalProvisioner({
    stateFile,
    configFile: path.join(dir, 'tunnel-config.yml'),
    homeDir: dir,
    seed: 'seed',
    probe,
  });
}

console.log('\n重新检测解析（解自锁死）\n');

// 1. 用户改好 NS 后：强制重探 → 通过 → 状态写回 dnsOk=true
{
  const dir = path.join(tmp, 'case-ok');
  const stateFile = seedState(dir);
  const prov = makeProvisioner(stateFile, async () => ({
    ok: true, kind: 'CNAME', records: [`${TUNNEL_ID}.cfargotunnel.com`],
  }));
  const before = prov.status();
  check('重检前 status.dnsOk 为 false（面板此刻禁用）', before.dnsOk === false);
  const res = await prov.recheckDns();
  check('重探通过 ok=true', res.ok === true, JSON.stringify(res));
  check('重探结果未被判为篡改', res.tampered === false);
  check('状态文件已写回 dnsOk=true', JSON.parse(fs.readFileSync(stateFile, 'utf8')).dnsOk === true);
  check('status() 立刻反映可解析（面板可恢复点击）', prov.status().dnsOk === true);
  check('status() 带 dnsCheckedAt 供面板展示', typeof prov.status().dnsCheckedAt === 'string');
  check('文案里不再有 pending 告警', prov.status().warning === null);
}

// 2. NS 仍指错：重探失败但结论明确，且必须给出可执行告警
{
  const dir = path.join(tmp, 'case-pending');
  const stateFile = seedState(dir);
  const prov = makeProvisioner(stateFile, async () => ({ ok: false, kind: null, records: [] }));
  const res = await prov.recheckDns();
  check('重探失败 ok=false', res.ok === false);
  check('失败时仍返回 warning 供面板展示', typeof res.warning === 'string' && res.warning.length > 0);
  check('warning 点明 zone pending / NS 指向问题', /pending|NS/.test(res.warning || ''));
  check('失败也刷新了 dnsCheckedAt（避免每轮都重探）',
    JSON.parse(fs.readFileSync(stateFile, 'utf8')).dnsCheckedAt !== '2026-11-20T00:00:00.000Z');
}

// 3. CNAME 被改指：按「地址不可用」处理，绝不能当成可用
{
  const dir = path.join(tmp, 'case-tampered');
  const stateFile = seedState(dir);
  const prov = makeProvisioner(stateFile, async () => ({
    ok: true, kind: 'CNAME', records: ['someone-else.cfargotunnel.com'],
  }));
  const res = await prov.recheckDns();
  check('改指被判为 tampered', res.tampered === true);
  check('改指时 ok=false（拒绝下发地址）', res.ok === false);
  check('返回期望与本机实际指向供排障',
    res.expected === `${TUNNEL_ID}.cfargotunnel.com` && res.target === 'someone-else.cfargotunnel.com');
}

// 4. 未开通时重检不报错，如实告诉面板没东西可检
{
  const dir = path.join(tmp, 'case-empty');
  fs.mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, 'tunnel-named.json');
  const prov = makeProvisioner(stateFile, async () => ({ ok: true, kind: 'A', records: ['1.2.3.4'] }));
  const res = await prov.recheckDns();
  check('未开通时 provisioned=false', res.provisioned === false);
  check('未开通时不抛错', res.ok === false);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败\n`);
if (failures.length) process.exit(1);
