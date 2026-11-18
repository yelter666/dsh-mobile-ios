// file-log.mjs — 网关自己的运行日志（落盘，可事后取证）
//
// 为什么需要它：插件跑在宿主进程内，`ctx.logger` 的输出进了 Electron 主进程，
// 用户机器上根本拿不到；`~/Library/Logs/DeepSeek Harness` 是空目录。结果就是
// 「手机发不出去」只能靠猜——前几轮为此反复改错地方。
//
// 纪律：
//   · 任何写日志失败都必须被吞掉（R12：插件不能把宿主带崩）；
//   · 单文件 2MB 封顶，超了滚动到 .1（不保留更多，够定位一次事故即可）；
//   · 只记结构化事实（事件名 + 少量字段），不记消息正文与设备令牌。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;

export function defaultLogFile() {
  return path.join(os.homedir(), '.dsh', 'mobile-access', 'logs', 'dsh-mobile-ios.log');
}

/**
 * @param {object} opts
 * @param {string} [opts.file] 日志路径
 * @param {(msg: string) => void} [opts.mirror] 同时往宿主 logger 发一份（开发态看控制台）
 */
export function createFileLog({ file = defaultLogFile(), mirror = null } = {}) {
  let ready = false;

  const rotateIfNeeded = () => {
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      /* 文件不存在或改名失败：都不影响继续追加 */
    }
  };

  const ensureDir = () => {
    if (ready) return true;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      ready = true;
      return true;
    } catch {
      return false;
    }
  };

  return function log(msg) {
    const line = `{"at":"${new Date().toISOString()}","pid":${process.pid}","msg":${JSON.stringify(String(msg))}}\n`;
    try {
      if (ensureDir()) {
        rotateIfNeeded();
        fs.appendFileSync(file, line);
      }
    } catch {
      /* 落盘失败不影响业务 */
    }
    if (mirror) {
      try {
        mirror(String(msg));
      } catch {
        /* 镜像同样不能抛 */
      }
    }
  };
}
