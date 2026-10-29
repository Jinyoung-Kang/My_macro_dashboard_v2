#!/usr/bin/env bash
# =============================================================================
# scripts/aws/update-cloudfront-ranges.sh — CloudFront 원본용(origin-facing) IP 대역으로 deploy/aws/trusted_proxies.caddy를 다시 만듭니다
# (ADR 0019 결정 16, 포트폴리오 aws-deploy/scripts/update-cloudfront-ranges.sh와 같음).
# Caddy는 :8301에서 이 대역이 보낸 X-Forwarded-For만 믿습니다. AWS가 대역을 바꾸므로 deploy.sh가 배포 때마다 부릅니다.
# 받지 못하거나 대역이 너무 적으면 파일을 바꾸지 않고 0이 아닌 값으로 끝납니다(deploy.sh는 지난 파일이 있으면 그것으로 계속).
#   bash scripts/aws/update-cloudfront-ranges.sh && docker compose up -d --no-deps --force-recreate caddy
# =============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
OUT="deploy/aws/trusted_proxies.caddy"
tmp="$(mktemp)"
trap 'rm -f "$tmp" "$tmp.out"' EXIT
curl -fsS --max-time 30 https://ip-ranges.amazonaws.com/ip-ranges.json -o "$tmp"
python3 -I - "$tmp" "$tmp.out" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
v4 = sorted({p["ip_prefix"] for p in data["prefixes"] if p["service"] == "CLOUDFRONT_ORIGIN_FACING"})
v6 = sorted({p["ipv6_prefix"] for p in data.get("ipv6_prefixes", []) if p["service"] == "CLOUDFRONT_ORIGIN_FACING"})
if len(v4) < 10:
    sys.exit(f"CLOUDFRONT_ORIGIN_FACING 대역이 너무 적음({len(v4)}) — 파일을 바꾸지 않음")
with open(sys.argv[2], "w") as f:
    f.write(f"# 자동 생성 — scripts/aws/update-cloudfront-ranges.sh (ip-ranges.json syncToken {data['syncToken']})\n")
    f.write("trusted_proxies static " + " ".join(v4 + v6) + "\n")
print(f"  CloudFront 원본용 대역: IPv4 {len(v4)} · IPv6 {len(v6)}")
PY
mv "$tmp.out" "$OUT"
chmod 644 "$OUT"
