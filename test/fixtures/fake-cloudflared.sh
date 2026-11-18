#!/bin/sh
# 模拟 cloudflared Quick Tunnel 的输出格式，用于隧道生命周期验证。
# 域名里带 $$（进程 PID），保证每次启动地址不同 —— 这正是地址漂移场景。
echo "2026-11-15T12:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so means..."
echo "2026-11-15T12:00:01Z INF |  https://spike-$$.trycloudflare.com  |"
echo "2026-11-15T12:00:02Z INF Registered tunnel connection connIndex=0 location=hkg06"
trap 'exit 0' TERM INT
while true; do sleep 0.2; done
