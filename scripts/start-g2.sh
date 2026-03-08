#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CC_G2="${SCRIPT_DIR}/cc-g2.sh"

warn() { printf '[g2] %s\n' "$*"; }

warn "start-g2.sh は legacy です。内部で cc-g2 に委譲します。"

case "${1:-start}" in
  start)
    exec "$CC_G2"
    ;;
  stop)
    exec "$CC_G2" stop
    ;;
  status)
    exec "$CC_G2" status
    ;;
  '!')
    exec "$CC_G2" '!'
    ;;
  *)
    echo "Usage: $0 [start|stop|status|!]"
    echo "  start  -> cc-g2"
    echo "  stop   -> cc-g2 stop"
    echo "  status -> cc-g2 status"
    echo "  !      -> cc-g2 !"
    exit 1
    ;;
esac
