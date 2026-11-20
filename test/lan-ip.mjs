// test/lan-ip.mjs — 手机要填的「电脑地址」怎么挑
//
// 真实现场：Windows 装了 WSL / Hyper-V / VMware 后，系统里会多出 172.x 的虚拟网卡；
// macOS 开着 VPN 时会有 utun*。若按「第一个私网 IPv4」取，二维码里就可能是这些
// 手机根本连不上的地址——扫码后一直转圈，看起来像插件坏了。
// 这里锁住优先级：物理网卡 > 虚拟网卡，且在物理网卡里优先 192.168 > 10 > 172.16/12。

import { lanIPv4 } from '../src/server.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const v4 = (address, extra = {}) => ({ address, family: 'IPv4', internal: false, ...extra });
const v6 = (address) => ({ address, family: 'IPv6', internal: false });

console.log('\n局域网地址选择回归\n');

// 1. Windows：WSL 虚拟网卡排在前面，也要挑 Wi-Fi
check('跳过 vEthernet(WSL)，挑 Wi-Fi',
  lanIPv4({
    'vEthernet (WSL)': [v4('172.20.16.1')],
    'Wi-Fi': [v4('192.168.1.5')],
  }) === '192.168.1.5');

// 2. Windows：Hyper-V 与 VMware 都不能被选
check('跳过 Hyper-V 与 VMware',
  lanIPv4({
    'vEthernet (Default Switch)': [v4('172.18.0.1')],
    'VMware Network Adapter VMnet8': [v4('192.168.226.1')],
    '以太网': [v4('10.0.0.7')],
  }) === '10.0.0.7');

// 3. macOS：VPN 的 utun 优先级最低
check('跳过 utun（VPN），挑 en0',
  lanIPv4({
    utun3: [v4('10.8.0.2')],
    en0: [v4('192.168.31.44')],
  }) === '192.168.31.44');

// 4. 同为物理网卡时，192.168 优先于 10/172
check('192.168 优先于 172.16/12',
  lanIPv4({
    '以太网': [v4('172.16.5.9')],
    'Wi-Fi': [v4('192.168.0.12')],
  }) === '192.168.0.12');

// 5. 只有虚拟网卡时不能返回 null（降级也要给出一个可尝试的地址）
check('只有虚拟网卡也返回地址（降级）',
  lanIPv4({ 'vEthernet (WSL)': [v4('172.20.16.1')] }) === '172.20.16.1');

// 6. 没有可用网卡 → null
check('没有私网 IPv4 返回 null',
  lanIPv4({ lo: [v4('127.0.0.1', { internal: true })] }) === null);
check('空表返回 null', lanIPv4({}) === null);

// 7. 内部地址与公网地址都要跳过
check('跳过 internal 与公网 IPv4',
  lanIPv4({
    lo: [v4('192.168.1.2', { internal: true })],
    eth0: [v4('8.8.8.8')],
    en0: [v4('192.168.1.9')],
  }) === '192.168.1.9');

// 8. IPv6 不参与选择（手机端填的是 IPv4:port）
check('忽略 IPv6 条目', lanIPv4({ en0: [v6('fe80::1')] }) === null);

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败\n`);
if (failures.length) process.exit(1);
