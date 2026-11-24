#!/usr/bin/env python3
"""
scripts/qa/perf-seed.py — 성능 재현용 QA 씨앗(성능 개선 2차, 2026-11-24): 운영 규모의 합성 보안 공지·버전 목록과 13F 즐겨찾기 12곳.

QA 스택 전용입니다. 운영 DB(로컬 3002 스택·Vultr 서버)와 시험 DB(macrodash_test)에 넣지 않습니다 — 아래 쓰는 법은 QA 스택의 컨테이너에만 닿습니다.
값은 모두 지어낸 것입니다: 글 번호 910001~910135, CVE-2098-*·CVE-2099-*, 버전은 실제로 없는 큰 숫자, 주소는 example.invalid.
운영의 공지 원문·근거 버전·실제 계좌 자료를 가져오지 않습니다(저장소가 공개). 의존성 없이 표준 라이브러리만 씁니다. 같은 씨앗 값이라 늘 같은 자료가 나옵니다.

규모(2026-11-24 운영 통계 표의 크기에 맞춤): 공지 135건(본문 합 약 220 kB)·표 행 약 2,000, 구성 요소 약 1,700, 변경 기록 CVE 약 11,300,
추적기 결과 9줄, 13F 즐겨찾기 12곳(가짜 CIK 0009900001~0009900012 — 기관마다 q8·q30 저장본, QA DB의 기존 13F 저장본 가운데 큰 것을 복사).

쓰는 법(저장소 최상위에서, QA 스택이 떠 있을 때 — 먼저 기존 씨앗 scripts/qa/security-seed.sql을 넣었으면 그 다섯 공지도 그대로 남습니다):
  python3 scripts/qa/perf-seed.py sql | bash scripts/qa/qa-stack.sh exec postgres sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
  python3 scripts/qa/perf-seed.py inventory | bash scripts/qa/qa-stack.sh exec collector python -m app.inventory
  - sql: 보안 공지·표 행·추적기 결과(수집기 표 — QA는 외부가 막혀 이 씨앗이 그 자리를 채움, security-seed.sql과 같은 관례)와 13F 즐겨찾기
    (백엔드 표 sec13f_favorites — 설명 칸 '[QA 성능 씨앗]'으로 가림). 여러 번 넣어도 같은 번호를 지우고 다시 넣습니다.
  - inventory: 버전 목록 한 벌(수집기의 받기 길 app.inventory로 — ADR 0046 결정 2·ADR 0008). scripts/qa/security-inventory.tsv의 줄을 앞에 그대로
    두어 기존 씨앗 다섯 공지의 기대 판정(security-seed.sql 머리)은 바뀌지 않습니다.
지우기(QA): DELETE FROM security_notices WHERE ntt_id BETWEEN 910001 AND 910135; DELETE FROM distro_cve_status WHERE cve LIKE 'CVE-2098-%';
  DELETE FROM sec13f_favorites WHERE description = '[QA 성능 씨앗]';
  DELETE FROM snapshots WHERE name ~ '^sec\\.13f\\.00099000'; 버전 목록은 security-inventory.tsv를 다시 넣으면 원래대로.
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

SEED = 20261124
FIRST_ID = 910001
NOTICES = 135
MARK = "[QA 성능 씨앗]"
BASE_TSV = Path(__file__).with_name("security-inventory.tsv")

# 이 스택의 별칭에 걸리는 제품(판정이 실제로 일하는 줄)과 걸리지 않는 제품(무관 — 보호나라 월간 공지의 대부분).
MATCHED = ("PostgreSQL", "Node.js", "Python", "OpenSSL", "curl", "glibc", "OpenSSH", "Linux Kernel", "Brotli", "Apache Tomcat",
           "Spring Framework", "Next.js", "React", "Docker Engine", "containerd", "runc", "Git", "sudo", "APT", "Jackson")
UNMATCHED = tuple(f"QAFake {kind} {n}" for kind in ("Server", "Client", "Router", "Firewall", "Office", "Browser", "Mobile", "Plugin")
                  for n in range(1, 9))
NOTE_PLAIN = "※ 하단의 참고사이트를 확인하여 업데이트 수행 [1]"
NOTE_CONDITION = "※ 가짜 확장 기능을 켠 설치에서만 영향이 있으며, 해결 버전에서도 그 설정을 따로 바꿔야 함(QA 가짜 조건 문장)"

# 배포판 패키지(원본 이름) — 별칭의 배포판 제품과 이어지는 것과 그 밖의 흔한 이름(지어낸 판).
DISTRO_LINKED = ("openssl", "curl", "glibc", "openssh", "brotli", "apt", "sudo")
SECTIONS_DPKG = ("host", "collector", "browser")
SECTIONS_APK = ("backend", "postgres", "frontend", "caddy")


def q(text: str | None) -> str:
    return "NULL" if text is None else "'" + text.replace("'", "''") + "'"


def notice_sql(rng: random.Random) -> list[str]:
    out = ["BEGIN;",
           f"DELETE FROM security_notices WHERE ntt_id BETWEEN {FIRST_ID} AND {FIRST_ID + NOTICES - 1};",
           "DELETE FROM distro_cve_status WHERE cve LIKE 'CVE-2098-%';"]
    notices, rows = [], []
    cve = 10000
    for i in range(NOTICES):
        ntt = FIRST_ID + i
        layout = "product_table" if i % 9 else ("no_table" if i % 2 else "other_table")
        count = 0 if layout != "product_table" else rng.choice((1, 2, 3, 5, 8, 12, 16, 20, 25, 40, 50))
        products = []
        for row_no in range(count):
            product = rng.choice(MATCHED) if rng.random() < 0.35 else rng.choice(UNMATCHED)
            products.append(product)
            major = rng.randint(1, 95)
            low, high = f"{major}.0", f"{major}.{rng.randint(1, 9)}"
            ids = ", ".join(f"CVE-{rng.choice((2098, 2099))}-{cve + k}" for k in range(rng.choice((1, 1, 1, 2, 3))))
            cve += 4
            rows.append(f"({ntt}, {row_no}, {q(ids)}, {q(product)}, {q(f'{low} 이상 {high} 미만')}, {q(high)})")
        names = sorted(set(products)) or ["QAFake Notice"]
        notes = [NOTE_CONDITION, NOTE_PLAIN] if i % 11 == 0 else [NOTE_PLAIN]
        body = (f"QA 가짜 공지 {ntt}입니다. " + " ".join(f"{p} 제품의 가짜 취약점을 해결한 가짜 버전이 나왔습니다." for p in names)) * 6
        notices.append(
            f"({ntt}, {99100 + i}, {q('[QA 가짜] ' + ', '.join(names[:3]) + ' 등 보안 업데이트 권고')}, CURRENT_DATE - {i // 2}, "
            f"'https://example.invalid/qa/security/{ntt}', false, 'ok', 1, NULL, {q(layout)}, {q(json.dumps(names, ensure_ascii=False))}::jsonb, "
            f"{q(json.dumps(notes, ensure_ascii=False))}::jsonb, {q(body[:1700])}, now())")
    out.append("INSERT INTO security_notices (ntt_id, list_no, title, posted_on, url, pinned, detail_status, detail_attempts, detail_error,\n"
               "                              layout, products, notes, body_text, detail_fetched_at) VALUES\n  " + ",\n  ".join(notices) + ";")
    out.append("INSERT INTO security_notice_rows (ntt_id, row_no, cve, product, affected, fixed) VALUES\n  " + ",\n  ".join(rows) + ";")
    tracker = []
    for k, pkg in enumerate(("openssl", "curl", "glibc")):
        for distro, suite, status in (("ubuntu", "noble", "fixed"), ("debian", "trixie", "open"), ("debian", "trixie", "not_affected")):
            fixed = "NULL" if status != "fixed" else q(f"90.{k}-1ubuntu0.1")
            tracker.append(f"({q(distro)}, {q(suite)}, {q(pkg)}, 'CVE-2098-{20000 + k * 10 + len(tracker)}', {q(status)}, {fixed}, 'qa', now())")
    out.append("INSERT INTO distro_cve_status (distro, suite, package, cve, status, fixed_version, detail, checked_at) VALUES\n  "
               + ",\n  ".join(tracker) + "\nON CONFLICT (distro, suite, package, cve) DO NOTHING;")
    # 13F 즐겨찾기 12곳 — 운영처럼 기관마다 q8·q30 두 저장본(MB 단위)이 있게, 가짜 CIK 0009900001~0009900012에 QA DB의 기존 13F 저장본
    # (공개 SEC 자료에서 QA가 모은 것) 가운데 큰 것을 차례로 복사합니다. 저장본 표는 수집기 표지만 QA 씨앗의 관례대로 여기서 채웁니다.
    for quarters in ("8", "30"):
        out.append(f"""INSERT INTO snapshots (name, payload, kind, status, error, collected_at)
SELECT 'sec.13f.' || lpad((9900000 + n.k)::text, 10, '0') || '.q{quarters}', src.payload, src.kind, src.status, NULL, now()
FROM generate_series(1, 12) AS n(k)
JOIN (SELECT payload, kind, status, row_number() OVER (ORDER BY pg_column_size(payload) DESC) AS r, count(*) OVER () AS total
      FROM snapshots WHERE name ~ '^sec\\.13f\\.[0-9]{{10}}\\.q{quarters}$' AND name !~ '^sec\\.13f\\.00099000') src
  ON src.r = ((n.k - 1) % src.total) + 1
ON CONFLICT (name) DO UPDATE SET payload = EXCLUDED.payload, kind = EXCLUDED.kind, status = EXCLUDED.status, collected_at = EXCLUDED.collected_at;""")
    out.append(f"""DELETE FROM sec13f_favorites WHERE description = {q(MARK)};
INSERT INTO sec13f_favorites (cik, sec_name, display_name, description)
SELECT lpad((9900000 + k)::text, 10, '0'), 'QA FAKE FILER ' || k, '[QA] 가짜 제출자 ' || k, {q(MARK)} FROM generate_series(1, 12) AS k
ON CONFLICT (cik) DO NOTHING;""")
    out.append("COMMIT;")
    return out


def inventory_tsv(rng: random.Random) -> list[str]:
    lines = [line for line in BASE_TSV.read_text(encoding="utf-8").splitlines() if line.strip()]
    comps, changelog = [], []
    for n in range(1700):
        section = rng.choice(SECTIONS_DPKG + SECTIONS_APK + ("backend", "frontend", "collector"))
        if section in SECTIONS_DPKG and n % 3:
            origin = DISTRO_LINKED[n % len(DISTRO_LINKED)] if n % 13 == 0 else f"qafake-src{n % 400}"
            version = f"90.{n % 7}-{n % 5}ubuntu0.{n % 3}" if section == "host" else f"90.{n % 7}-{n % 5}"
            comps.append(f"component\t{section}\tdpkg\tlib{origin}{n}\t{version}\t{origin}")
            if section == "host":
                for _ in range(rng.randint(70, 130)):
                    changelog.append(f"changelog\t{origin}\t{version}\tCVE-{rng.choice((2098, 2099))}-{rng.randint(10000, 18000)}")
        elif section in SECTIONS_APK and n % 2:
            origin = DISTRO_LINKED[n % len(DISTRO_LINKED)] if n % 13 == 0 else f"qafake-apk{n % 300}"
            comps.append(f"component\t{section}\tapk\t{origin}-libs{n}\t90.{n % 9}-r{n % 4}\t{origin}")
        else:
            eco = {"backend": "maven", "frontend": "npm", "collector": "pypi"}.get(section, "npm")
            sect = section if eco != "npm" or section == "frontend" else "frontend"
            comps.append(f"component\t{sect}\t{eco}\tqafake-{eco}-{n}\t{n % 40}.{n % 13}.{n % 7}\t-")
    pending = [f"pending\tlibqafake{n}\tamd64\t90.{n}-1\t90.{n}-2\tnoble-updates{',noble-security' if n % 3 == 0 else ''}"
               for n in range(30)]
    return lines + comps + pending + changelog


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    rng = random.Random(SEED)
    if mode == "sql":
        print("\n".join(notice_sql(rng)))
    elif mode == "inventory":
        print("\n".join(inventory_tsv(rng)))
    else:
        print("사용: perf-seed.py sql | perf-seed.py inventory (자세한 것은 파일 머리 설명)", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
