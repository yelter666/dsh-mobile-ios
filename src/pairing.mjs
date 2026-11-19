// pairing.mjs — 配对与设备凭证（GW-4 / GW-7）
// 安全约束（不可放松）：
//   · 配对码 6 位数字、TTL 300s、单次有效、生成 5 次/分钟；
//   · 错 5 次锁定 60s，且锁定期间不泄露"码对不对"；
//   · 凭证只存哈希，内存里不保留明文副本；
//   · 撤销是"整设备"语义，客户端收到 4009 必须清本地凭证并停止重连。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fail } from './protocol.mjs';

const CODE_TTL_SEC = 300;
const CODE_MAX_ATTEMPTS = 5;
const CODE_RATE_LIMIT = 5;
const CODE_RATE_WINDOW_MS = 60_000;
const LOCK_MS = 60_000;
const TOKEN_TTL_SEC = 30 * 24 * 3600;
// 活跃设备上限：一台电脑的可信手机就那么几台；不设上限的话，每次重装 App
// / 重新配对都会新增一条记录（历史上堆到过 60 条），面板数字失去意义。
const MAX_ACTIVE_DEVICES = 5;

const SCOPES = ['tasks.read', 'tasks.write', 'todos.answer', 'artifacts.read'];
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// 持久化（借鉴 dsh-plugin-mobile-gateway 的 gateway-state 原子写模式）：
//   · tmp 文件 + rename，写一半进程死掉不会留下半截 JSON；
//   · 目录 0700 / 文件 0600，只存 token 哈希，不存明文；
//   · 有意偏离第三方的「损坏即 fail-fast」：我们的插件跑在宿主进程内（R12），
//     状态文件损坏不该带崩宿主——改成备份损坏文件后空表启动。
function loadDevices(file, log) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.devices)) throw new Error('结构不符');
    const now = Date.now();
    // 过期设备加载时即丢弃（撤销的保留：audit 语义 + 4009 响应需要知道它存在过）
    return parsed.devices.filter((d) => d && typeof d.deviceTokenHash === 'string'
      && (!d.expiresAt || Date.parse(d.expiresAt) > now));
  } catch (err) {
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.renameSync(file, backup);
      log(`pair  设备注册表损坏，已备份到 ${path.basename(backup)} 并空表启动（${err.message}）`);
    } catch {
      log(`pair  设备注册表损坏且备份失败，空表启动（${err.message}）`);
    }
    return [];
  }
}

function saveDevices(file, devices) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const payload = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), devices }, null, 2);
  try {
    fs.writeFileSync(tmp, payload, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* 刚写的文件权限已正确 */ }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* rename 成功时 tmp 已不存在 */ }
  }
}

export class PairingService {
  constructor({ now = () => Date.now(), log = () => {}, file = null } = {}) {
    this.now = now;
    this.log = log;
    this.file = file; // 提供则设备注册表落盘；不提供保持纯内存（测试/临时实例）
    this.code = null; // { value, expiresAt, attempts, deviceName }
    this.lockedUntil = 0;
    this.issued = []; // 时间戳数组，用于限速
    this.devices = new Map(); // tokenHash -> device
    this.byDeviceId = new Map();
    if (this.file) this.#load();
  }

  #load() {
    try {
      let deduped = 0;
      for (const device of loadDevices(this.file, this.log)) {
        // 同一 installId 只认最新一条：历史上重配对会堆积重复记录（同机 6 条），
        // 旧的直接标记撤销——audit 语义保留，verify() 对它们回 4009。
        const existing = [...this.devices.values()].find((d) => !d.revoked && d.installId === device.installId);
        if (existing && String(existing.createdAt) > String(device.createdAt)) {
          device.revoked = true;
          deduped += 1;
        } else if (existing) {
          existing.revoked = true;
          deduped += 1;
        }
        this.devices.set(device.deviceTokenHash, device);
        this.byDeviceId.set(device.deviceId, device);
      }
      // 历史积压一并压回上限：活跃设备只保留最新 5 台，更旧的标记撤销
      // （手机下次请求收到 4009，重新扫码即可，不丢 audit 记录）。
      const overflow = [...this.devices.values()].filter((d) => !d.revoked)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(MAX_ACTIVE_DEVICES);
      for (const device of overflow) device.revoked = true;
      if (overflow.length) deduped += overflow.length;
      const n = this.devices.size;
      if (n) this.log(`pair  从注册表恢复 ${n} 台设备（活跃 ${[...this.devices.values()].filter((d) => !d.revoked).length}）${deduped ? `，按上限/去重回收 ${deduped} 条旧记录` : ''}`);
      if (deduped) this.#persist();
    } catch (err) {
      // 读盘失败（权限等）不阻塞启动：R12——网关以降级形态活着，手机最多重新配对
      this.log(`pair  设备注册表读取失败，本次以内存态运行：${err.message}`);
    }
  }

  #persist() {
    if (!this.file) return;
    try {
      saveDevices(this.file, [...this.devices.values()]);
    } catch (err) {
      this.log(`pair  设备注册表写入失败（内存态不受影响）：${err.message}`);
    }
  }

  #prune() {
    const cutoff = this.now() - CODE_RATE_WINDOW_MS;
    this.issued = this.issued.filter((t) => t > cutoff);
  }

  issueCode({ deviceName = 'iOS 设备' } = {}) {
    this.#prune();
    if (this.issued.length >= CODE_RATE_LIMIT) {
      const retryAfterMs = Math.max(1000, this.issued[0] + CODE_RATE_WINDOW_MS - this.now());
      throw fail(4029, undefined, { retryAfterMs });
    }
    const value = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = this.now() + CODE_TTL_SEC * 1000;
    this.code = { value, expiresAt, attempts: CODE_MAX_ATTEMPTS, deviceName };
    this.issued.push(this.now());
    this.log(`pair  code=${value} ttl=${CODE_TTL_SEC}s`);
    return {
      code: value,
      expiresAt: new Date(expiresAt).toISOString(),
      expiresInSec: CODE_TTL_SEC,
      attemptsRemaining: CODE_MAX_ATTEMPTS,
    };
  }

  redeem({ code, deviceName, installId, platform = 'ios', appVersion = '' }) {
    if (!code || !/^\d{6}$/.test(String(code))) throw fail(4400, '配对码应为 6 位数字');
    if (!installId) throw fail(4400, '缺少 installId');

    if (this.lockedUntil > this.now()) {
      throw fail(4008, undefined, { retryAfterMs: this.lockedUntil - this.now() });
    }
    if (!this.code || this.code.expiresAt <= this.now()) {
      throw fail(4008, '配对码已过期，请重新生成');
    }
    if (code !== this.code.value) {
      this.code.attempts -= 1;
      if (this.code.attempts <= 0) {
        this.code = null;
        this.lockedUntil = this.now() + LOCK_MS;
        this.log('pair  连错 5 次，锁定 60s');
      }
      throw fail(4008, undefined, { attemptsRemaining: Math.max(0, this.code?.attempts ?? 0) });
    }

    // 单次有效：兑换即作废，不留复用窗口
    const matchedDeviceName = this.code.deviceName;
    this.code = null;

    // 同一 installId 重新配对 = 换凭证，不是新增设备：覆盖旧记录。
    // 旧行为是无脑新增，同一台手机重装一次 App 就多一条（曾堆到 60 条）。
    for (const [hash, d] of [...this.devices]) {
      if (d.installId === installId && !d.revoked) {
        this.devices.delete(hash);
        this.byDeviceId.delete(d.deviceId);
      }
    }

    // 活跃设备上限：满员时挤掉最旧的一台（标记撤销保留在表内做 audit，
    // 那台手机下次请求会收到 4009 并清凭证重新配对）。
    const active = [...this.devices.values()].filter((d) => !d.revoked)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    while (active.length >= MAX_ACTIVE_DEVICES) {
      const oldest = active.shift();
      oldest.revoked = true;
      this.log(`pair  活跃设备已达上限 ${MAX_ACTIVE_DEVICES}，挤掉最旧的 ${oldest.deviceName || oldest.deviceId}`);
    }

    const token = `dt_${crypto.randomBytes(18).toString('hex')}`;
    const device = {
      deviceId: `dev_${crypto.randomBytes(4).toString('hex')}`,
      deviceTokenHash: sha256(token),
      installId,
      deviceName: deviceName || matchedDeviceName,
      platform,
      appVersion,
      scopes: [...SCOPES],
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + TOKEN_TTL_SEC * 1000).toISOString(),
      revoked: false,
    };
    this.devices.set(device.deviceTokenHash, device);
    this.byDeviceId.set(device.deviceId, device);
    this.#persist();
    this.log(`pair  兑换成功 device=${device.deviceId}`);
    return {
      deviceId: device.deviceId,
      deviceToken: token,
      tokenType: 'Bearer',
      expiresAt: device.expiresAt,
      scopes: device.scopes,
      pairedAt: device.createdAt,
    };
  }

  /** 校验 Bearer；失败抛 4001 / 4009（已撤销），均由客户端做不同处理 */
  verify(token) {
    if (!token) throw fail(4001);
    const device = this.devices.get(sha256(token));
    if (!device) throw fail(4001);
    if (device.revoked) throw fail(4009);
    if (Date.parse(device.expiresAt) <= this.now()) throw fail(4001);
    return device;
  }

  revokeAll() {
    let n = 0;
    for (const d of this.devices.values()) {
      if (!d.revoked) {
        d.revoked = true;
        n += 1;
      }
    }
    if (n) {
      this.#persist();
      this.log(`pair  撤销全部设备 n=${n}`);
    }
    return n;
  }

  /**
   * 桌面面板的设备清单：只回显展示字段，绝不泄露 deviceTokenHash / installId。
   * 撤销过的设备不入列——面板问的是「现在还能连上来的设备」，
   * 历史审计记录留在注册表里供 verify() 回 4009，但不给用户看。
   */
  listDevices() {
    return [...this.devices.values()]
      .filter((d) => !d.revoked && (!d.expiresAt || Date.parse(d.expiresAt) > this.now()))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((d) => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName || d.deviceId,
        platform: d.platform,
        appVersion: d.appVersion,
        createdAt: d.createdAt,
        expiresAt: d.expiresAt,
      }));
  }

  /** 单设备下线：设备下次带旧凭证请求会收到 4009 并清本地凭证。 */
  revokeDevice(deviceId) {
    const device = this.byDeviceId.get(String(deviceId || ''));
    if (!device || device.revoked) return 0;
    device.revoked = true;
    this.#persist();
    this.log(`pair  下线设备 device=${device.deviceId} name=${device.deviceName || '-'}`);
    return 1;
  }

  get maxDevices() { return MAX_ACTIVE_DEVICES; }

  stats() {
    return {
      devices: this.devices.size,
      activeDevices: [...this.devices.values()].filter((d) => !d.revoked).length,
      codeActive: Boolean(this.code && this.code.expiresAt > this.now()),
      lockedUntil: this.lockedUntil > this.now() ? new Date(this.lockedUntil).toISOString() : null,
    };
  }
}
