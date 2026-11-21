#!/bin/sh
# 模拟「隧道运行中意外崩溃」的 cloudflared：吐出地址，存活 0.6s 后自行退出，
# 用于验证 TunnelManager 的自动重拉（借鉴 dsh-plugin-mobile-gateway）。
echo "2026-11-16T00:00:00Z INF |  https://crash-$$.trycloudflare.com  |"
echo "2026-11-16T00:00:01Z INF Registered tunnel connection connIndex=0 location=hkg06"
sleep 0.6
# 模拟被信号带走（非正常 exit 0）
kill -9 $$
