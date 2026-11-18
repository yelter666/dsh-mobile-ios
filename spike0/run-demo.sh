#!/usr/bin/env bash
# run-demo.sh — 一条命令跑完"网关 + 造事件 + Apple 客户端"
# 用途：本机自测、给桌面端同学演示"客户端真的能连"
# 注意：变量一律用 ${VAR} 形式；macOS 自带 bash 3.2 在非 UTF-8 locale 下
#       会把紧邻中文的 $VAR 误读进变量名（曾导致 "PORT: unbound variable"）。
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-3191}"
BIN="${BIN:-/tmp/dsh-demo}"
LOG="${LOG:-/tmp/dsh-sidecar.log}"

if [ ! -x "${BIN}" ]; then
  echo "-> 编译 Swift 演示客户端"
  swiftc -O spike0/demo-swift/main.swift -o "${BIN}"
fi

echo "-> 启动 sidecar（mock 宿主，端口 ${PORT}）"
node entries/sidecar.mjs --host=mock --dev --port="${PORT}" > "${LOG}" 2>&1 &
SPID=$!
trap 'kill ${SPID} 2>/dev/null || true' EXIT

for _ in $(seq 1 80); do
  if curl -sf "http://127.0.0.1:${PORT}/mobile/v1/health" > /dev/null 2>&1; then break; fi
  sleep 0.1
done

echo "-> 造 3 帧事件（走 dev 端点，不经宿主）"
for i in 1 2 3; do
  curl -s -X POST "http://127.0.0.1:${PORT}/__mock/emit" \
    -H 'content-type: application/json' \
    -d "{\"taskId\":\"tsk_a41f9c\",\"kind\":\"log\",\"data\":{\"line\":\"tick ${i}\"}}" > /dev/null
done

echo "-> 运行客户端"
set +e
"${BIN}" --port "${PORT}"
CODE=$?
set -e

echo ""
echo "客户端退出码：${CODE}"
echo "服务端日志（末 6 行）："
tail -6 "${LOG}"
exit "${CODE}"
