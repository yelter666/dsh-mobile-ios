#!/bin/sh
# 模拟「启动了但一直不吐地址」的 cloudflared，用于验证启动超时路径。
echo "2026-11-15T12:00:00Z INF Starting tunnel, attempting to connect..."
trap 'exit 0' TERM INT
while true; do sleep 0.2; done
