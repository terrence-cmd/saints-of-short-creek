#!/bin/bash
# Correlates infra-level signals during the ramp-driver.ps1 load test:
# network throughput (interface byte counters only -- no per-connection or
# content resolution), RAM, /tmp (tmpfs, same physical resource as RAM on
# this box -- confirmed via `findmnt /tmp`), orphaned uploads, and whether
# the node process is still listening.
#
# Launch via SSM using the same backgrounding pattern already proven on this
# box for cloudflared (a plain `nohup ... &` leaves the SSM RunCommand
# invocation hanging "InProgress" indefinitely):
#
#   setsid nohup bash /home/ec2-user/observer.sh ens5 \
#     > /home/ec2-user/observer.log 2>&1 < /dev/null &
#   disown
#
# Stop it afterwards with: pkill -f observer.sh

IFACE="${1:-ens5}"
PREV_RX=0
PREV_TX=0

echo "timestamp_utc,in_mbps,out_mbps,mem_used_mb,mem_free_mb,mem_avail_mb,tmp_use_pct,orphan_uploads,listening"

while true; do
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  read -r RX TX < <(awk -v i="$IFACE:" '$1==i {print $2, $10}' /proc/net/dev)
  if [ "$PREV_RX" != "0" ]; then
    RX_MBPS=$(( (RX - PREV_RX) * 8 / 1000000 ))
    TX_MBPS=$(( (TX - PREV_TX) * 8 / 1000000 ))
  else
    RX_MBPS=0
    TX_MBPS=0
  fi
  PREV_RX=$RX
  PREV_TX=$TX

  read -r MEM_USED MEM_FREE MEM_AVAIL < <(free -m | awk '/^Mem:/ {print $3, $4, $7}')
  TMP_PCT=$(df -h /tmp | awk 'NR==2 {print $5}')
  ORPHANS=$(ls /tmp/rawconv-* 2>/dev/null | wc -l)
  LISTENING=$(ss -ltnp 2>/dev/null | grep -c ":3000 ")

  echo "$TS,$RX_MBPS,$TX_MBPS,$MEM_USED,$MEM_FREE,$MEM_AVAIL,$TMP_PCT,$ORPHANS,$LISTENING"
  sleep 1
done
