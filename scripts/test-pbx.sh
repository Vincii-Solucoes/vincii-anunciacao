#!/bin/sh
# Sobe/derruba um Asterisk de teste (ramais 1001–1003, senha "senha<ramal>") via Docker/Colima.
# Uso: sh scripts/test-pbx.sh start|stop|contacts
set -e
cd "$(dirname "$0")/.."
case "$1" in
  start)
    colima status >/dev/null 2>&1 || colima start --network-address >/dev/null
    docker rm -f vincii-pbx >/dev/null 2>&1 || true
    docker create --name vincii-pbx --network host andrius/asterisk:latest >/dev/null
    for f in pjsip.conf extensions.conf rtp.conf; do docker cp "test/pbx/$f" "vincii-pbx:/etc/asterisk/$f"; done
    docker start vincii-pbx >/dev/null
    sleep 6
    echo "PBX em $(colima list 2>/dev/null | awk 'NR==2{print $NF}'):5060"
    ;;
  stop)
    docker rm -f vincii-pbx >/dev/null 2>&1 || true
    colima stop >/dev/null 2>&1 || true
    ;;
  contacts)
    docker exec vincii-pbx asterisk -rx "pjsip show contacts"
    ;;
esac
