#!/bin/sh
# 模拟「token 方式（named tunnel）」的 cloudflared 输出：
# 固定域名不会打印，只在连接注册成功时给一行 Registered tunnel connection。
echo "2026-11-18T00:00:00Z INF Starting tunnel tunnelID=fake-named-tunnel"
echo "2026-11-18T00:00:00Z INF Version 2026.10.7"
echo "2026-11-18T00:00:01Z INF Registered tunnel connection connIndex=0 connection=fake01 location=hkg01 protocol=quic"
trap 'exit 0' TERM INT
while true; do sleep 0.2; done
