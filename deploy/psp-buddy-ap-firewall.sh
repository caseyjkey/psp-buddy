#!/bin/sh
set -eu

PSP_IFACE=wlp25s0u2
NFT_FILE=/home/alpha/Development/psp-buddy/deploy/psp-buddy-ap.nft

iptables_add() {
  /usr/bin/iptables -w -C INPUT "$@" 2>/dev/null ||
    /usr/bin/iptables -w -I INPUT 1 "$@"
}

iptables_delete() {
  while /usr/bin/iptables -w -C INPUT "$@" 2>/dev/null; do
    /usr/bin/iptables -w -D INPUT "$@"
  done
}

stop_firewall() {
  iptables_delete -i "$PSP_IFACE" -p udp --dport 67 -j ACCEPT
  iptables_delete -i "$PSP_IFACE" -p tcp --dport 17322 -j ACCEPT
  iptables_delete -i "$PSP_IFACE" -p icmp --icmp-type echo-request -j ACCEPT

  if /usr/bin/nft list table inet psp_buddy >/dev/null 2>&1; then
    /usr/bin/nft delete table inet psp_buddy
  fi
}

case "${1:-}" in
  start)
    if /usr/bin/nft list table inet psp_buddy >/dev/null 2>&1; then
      /usr/bin/nft delete table inet psp_buddy
    fi
    /usr/bin/nft -f "$NFT_FILE"

    # Gilbert also has an iptables INPUT policy of DROP. nftables ACCEPT
    # verdicts do not bypass a later iptables base chain, so mirror only the
    # three interface-scoped permits needed by the isolated PSP network.
    iptables_add -i "$PSP_IFACE" -p udp --dport 67 -j ACCEPT
    iptables_add -i "$PSP_IFACE" -p tcp --dport 17322 -j ACCEPT
    iptables_add -i "$PSP_IFACE" -p icmp --icmp-type echo-request -j ACCEPT
    ;;
  stop)
    stop_firewall
    ;;
  restart)
    stop_firewall
    "$0" start
    ;;
  *)
    echo "usage: $0 {start|stop|restart}" >&2
    exit 2
    ;;
esac
