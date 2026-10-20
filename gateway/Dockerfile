# Pi Privacy Gateway - WireGuard VPN server + exit selection (WARP / any WireGuard
# provider / Tor) + kill switch + live dashboard, in one host-networked container.
FROM debian:trixie-slim

ARG TARGETARCH
ARG WGCF_VERSION=2.3.0

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      wireguard-tools iproute2 iptables iputils-ping iw tor curl ca-certificates \
      python3 dnsutils qrencode procps supervisor tini \
 && rm -rf /var/lib/apt/lists/*

# wgcf registers a free Cloudflare WARP account and writes a WireGuard profile for it
RUN case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) A=amd64 ;; arm64) A=arm64 ;; armhf|arm) A=armv7 ;; *) echo "unsupported arch" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/wgcf \
      "https://github.com/ViRb3/wgcf/releases/download/v${WGCF_VERSION}/wgcf_${WGCF_VERSION}_linux_${A}" \
 && chmod 755 /usr/local/bin/wgcf

COPY bin/ /usr/local/bin/
COPY supervisord.conf /etc/supervisor/conf.d/pgw.conf
COPY dashboard/ /opt/pgw/dashboard/
RUN chmod 755 /usr/local/bin/pgw*

# WireGuard configs stay at the real /etc/wireguard path: Ubuntu's AppArmor profile for
# wg-quick (it applies inside containers too) only allows reading configs from there.
VOLUME ["/config", "/etc/wireguard"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/pgw-entrypoint"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD /usr/local/bin/pgw status --quiet || exit 1
