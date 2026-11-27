#!/usr/bin/env python3
"""
scripts/qa/perf-seed.py — 성능 재현용 QA 씨앗(성능 개선 2차, 2026-11-24): 운영 규모의 합성 보안 공지·버전 목록과 13F 즐겨찾기 12곳.
3차(2026-11-27)에 검색 피드 재현 자료(feed)를 더했습니다 — 관심 대상 한 곳(us:NVDA)의 타임라인에 합성 글 약 2,750줄.

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
  python3 scripts/qa/perf-seed.py feed | bash scripts/qa/qa-stack.sh exec postgres sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
  - feed: 검색 피드 재현(2026-11-27 운영의 /api/search/feed?e=us:NVDA&tab=timeline — 2,756줄·7일 1,647·30일 2,079·1년 2,334). 수집기의 읽기 상한
    (services/search_store — 모은 글 1000·피드 묶음 500)은 그대로 두고 세 출처로 나눠 넣습니다: 모은 글 search_watch_items 1,050행(상한에 걸려
    1,000줄 — 운영처럼 '최근 1000건까지만 읽음'), 새 피드 묶음 observations search_feed_headline 480행, 사건 뉴스 observations news_headline 1,276행.
    합쳐 약 2,756줄이고 최근 30일에 약 75%(7일 1,480·30일 2,080·1년 2,335)입니다. 시각은 넣는 순간 기준이라 날이 지나면 다시 넣어야 같은 분포입니다.
    줄의 약 4분의 1은 같은 사건을 여러 가짜 매체가 쓴 꼴(제목 낱말이 겹침 — 같은 글 묶기가 일함)이고, 제목은 영어·한국어가 섞입니다.
    모두 지어낸 글입니다: 제목은 낱말 주머니에서 뽑은 조합에 'NVIDIA'(QA가 푸는 us:NVDA의 이름 — 피드 묶음·사건 뉴스는 이름으로 찾음)를 넣은 것,
    매체는 '[QA] 가짜 매체 NN', 주소는 https://mediaNN.example.invalid/qa-perf/…, 요약은 '[QA 성능 씨앗]'으로 시작합니다.
    사건 뉴스(news_headline)는 모의 매매 패킷·정보 화면도 읽는 표라, 그쪽에 섞이지 않게 **8일보다 오래된 날짜로만** 넣고 feed 칸을 'qa_perf_seed'로
    적습니다(최근 사건을 읽는 패킷 창 밖 — 다만 QA DB가 오래된 복원본이면 /info/news의 앞쪽에 이 줄이 보입니다). 검색 첫 화면의
    '새 피드 묶음 최근 30건'과 /info/news?set=world에도 이 씨앗의 묶음 줄이 보입니다.
    첫 운영자의 관심 대상에 us:NVDA를 더합니다(백엔드 표 search_watches — 이미 있으면 그대로).
지우기(QA): DELETE FROM security_notices WHERE ntt_id BETWEEN 910001 AND 910135; DELETE FROM distro_cve_status WHERE cve LIKE 'CVE-2098-%';
  DELETE FROM sec13f_favorites WHERE description = '[QA 성능 씨앗]';
  DELETE FROM snapshots WHERE name ~ '^sec\\.13f\\.00099000'; 버전 목록은 security-inventory.tsv를 다시 넣으면 원래대로.
  feed: DELETE FROM search_watch_items WHERE item_id LIKE 'qaperf%'; DELETE FROM observations WHERE entity LIKE 'qaperf%';
  DELETE FROM search_watches WHERE entity_key = 'us:NVDA' AND name = '[QA 성능 씨앗] NVIDIA';
"""
from __future__ import annotations

import hashlib
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


# ---------------------------------------------------------------------------------------------------------------------------------
# 검색 피드 재현(feed) — 3차. 운영 응답의 건수와 기간 분포만 본뜨고 글은 모두 지어냅니다.
FEED_SEED = 20261127
FEED_ENTITY = "us:NVDA"
FEED_NAME = "NVIDIA"                    # QA가 us:NVDA를 풀 때의 이름(별칭) — 피드 묶음·사건 뉴스는 제목·요약에서 이 이름을 찾음
FEED_WATCH_NAME = "[QA 성능 씨앗] NVIDIA"
FEED_ID_PREFIX = "qaperf"
WATCH_ROWS, BUNDLE_ROWS, EVENT_ROWS = 1050, 480, 1276
PUBLISHERS = [(f"[QA] 가짜 매체 {n:02d}", f"media{n:02d}.example.invalid") for n in range(1, 41)]
EN_WORDS = ("chip", "demand", "revenue", "forecast", "supply", "export", "datacenter", "margin", "guidance", "order", "backlog", "shipment",
            "analyst", "target", "upgrade", "downgrade", "rally", "selloff", "earnings", "quarter", "outlook", "capacity", "foundry",
            "packaging", "memory", "server", "cloud", "contract", "partnership", "regulator", "tariff", "license", "inventory", "pricing",
            "roadmap", "launch", "delay", "recall", "lawsuit", "settlement", "buyback", "dividend", "stake", "filing", "insider",
            "valuation", "multiple", "benchmark", "index", "weighting", "options", "volatility", "hedge", "fund", "pension", "sovereign",
            "startup", "acquisition", "merger", "antitrust", "probe", "subsidy", "factory", "energy", "cooling", "network", "software",
            "robotics", "automotive", "gaming", "workstation", "laptop", "handset", "telecom", "utility", "grid", "copper", "wafer")
KO_WORDS = ("반도체", "수요", "매출", "전망", "공급", "수출", "데이터센터", "마진", "가이던스", "주문", "수주", "출하", "애널리스트", "목표가",
            "상향", "하향", "급등", "급락", "실적", "분기", "증설", "파운드리", "패키징", "메모리", "서버", "클라우드", "계약", "협력", "규제",
            "관세", "허가", "재고", "가격", "로드맵", "출시", "지연", "소송", "합의", "자사주", "배당", "지분", "공시", "밸류에이션", "지수",
            "옵션", "변동성", "헤지", "연기금", "국부펀드", "스타트업", "인수", "합병", "조사", "보조금", "공장", "전력", "냉각", "네트워크",
            "소프트웨어", "로봇", "자동차", "게임", "통신", "구리", "웨이퍼", "경쟁", "점유율", "투자", "설비", "고객", "납품", "차세대")


def _feed_titles(rng: random.Random, count: int) -> list[tuple[str, str, int | None]]:
    """(제목, 언어, 사건 번호|None) ``count``개 — 약 4분의 1은 같은 사건의 변주(낱말 한둘만 다름), 나머지는 서로 낱말이 거의 겹치지 않는 조합."""
    out: list[tuple[str, str, int | None]] = []
    seen: set[str] = set()
    story = 0

    def make(words: list[str], lang: str, tag: int) -> str:
        body = " ".join(words)
        return f"{FEED_NAME} {body} {tag}" if lang == "en" else f"{FEED_NAME} {body} {tag}건"

    while len(out) < count:
        lang = "en" if rng.random() < 0.6 else "ko"
        pool = EN_WORDS if lang == "en" else KO_WORDS
        base = rng.sample(pool, rng.randint(5, 8))
        tag = rng.randint(1000, 9999)
        if rng.random() < 0.09:                           # 같은 사건 — 2~7줄(매체만 다르고 제목 낱말 하나쯤 바뀜)
            story += 1
            for _ in range(rng.randint(2, 7)):
                words = list(base)
                if rng.random() < 0.7:
                    words[rng.randrange(len(words))] = rng.choice(pool)
                rng.shuffle(words)
                title = make(words, lang, tag)
                if title not in seen and len(out) < count:
                    seen.add(title)
                    out.append((title, lang, story))
        else:
            title = make(base, lang, tag)
            if title not in seen:
                seen.add(title)
                out.append((title, lang, None))
    return out


def _age_seconds(rng: random.Random, low_days: float, high_days: float) -> int:
    return int(rng.uniform(low_days, high_days) * 86400)


def feed_sql(rng: random.Random) -> list[str]:
    total = WATCH_ROWS + BUNDLE_ROWS + EVENT_ROWS
    titles = _feed_titles(rng, total)
    # 사건 묶음이 48시간 창 안에 들게, 같은 사건의 줄은 첫 줄의 시각에서 몇 시간 안에 둡니다.
    story_age: dict[tuple[str, int], int] = {}

    def age(kind: str, story: int | None, low: float, high: float) -> int:
        if story is None:
            return _age_seconds(rng, low, high)
        first = story_age.setdefault((kind, story), _age_seconds(rng, low + 0.5, max(low + 0.6, high - 0.5)))
        return max(int(low * 86400) + 60, first - rng.randint(0, 6 * 3600))

    def row_url(n: int, domain: str) -> str:
        return f"https://{domain}/qa-perf/{n:05d}"

    def row_id(url: str) -> str:
        return FEED_ID_PREFIX + hashlib.sha1(url.encode("utf-8")).hexdigest()[:18]

    def summary(n: int, title: str) -> str:
        return f"[QA 성능 씨앗] 지어낸 요약 {n}번입니다. {title} — 실제 기사가 아니며 주소는 example.invalid입니다. " + "가짜 문장을 이어 붙입니다. " * (n % 5)

    out = ["BEGIN;",
           f"DELETE FROM search_watch_items WHERE item_id LIKE '{FEED_ID_PREFIX}%';",
           f"DELETE FROM observations WHERE entity LIKE '{FEED_ID_PREFIX}%';"]
    watch, bundle, event = [], [], []
    for n, (title, lang, story) in enumerate(titles):
        publisher, domain = PUBLISHERS[rng.randrange(len(PUBLISHERS))]
        url = row_url(n, domain)
        ident = row_id(url)
        text = summary(n, title) if n % 4 else None        # 운영처럼 요약이 없는 줄도 섞음
        if n < WATCH_ROWS:                                  # 모은 글 — 가장 최근 7일(상한에 걸리는 50행은 그보다 조금 오래됨)
            seconds = age("w", story, 0.01, 6.9) if n < 1000 else _age_seconds(rng, 6.95, 6.99)
            origin = ("google_en", "bing", "yahoo", "finviz")[n % 4] if lang == "en" else ("google_ko", "bing", "infomax")[n % 3]
            watch.append(f"({q(FEED_ENTITY)}, {q(ident)}, 'news', {q(title)}, {q(url)}, {q(publisher)}, {q(domain)}, {q(origin)}, {q(lang)}, "
                         f"{q(text)}, now() - make_interval(secs => {seconds}), now() - make_interval(secs => {max(0, seconds - 900)}))")
        elif n < WATCH_ROWS + BUNDLE_ROWS:                  # 새 피드 묶음 — 최근 7일
            seconds = age("b", story, 0.01, 6.9)
            payload = {"title": title, "summary": text, "url": url, "publisher": publisher, "publisherDomain": domain, "feed": "qa_perf_seed",
                       "timeBasis": "published", "lang": lang}
            bundle.append(_observation_row("search_feed_headline", ident, payload, seconds, link_key=None))
        else:                                               # 사건 뉴스 — 8일보다 오래된 것만(패킷 창·정보 화면 첫 쪽 밖)
            k = n - WATCH_ROWS - BUNDLE_ROWS
            low, high = (8.0, 29.5) if k < 600 else ((30.5, 360.0) if k < 855 else (366.0, 720.0))
            seconds = age("e", story, low, high)
            payload = {"title": title, "summary": text, "link": url, "source": publisher, "feed": "qa_perf_seed", "feeds": ["qa_perf_seed"]}
            event.append(_observation_row("news_headline", ident, payload, seconds, link_key="link"))
    out.append("INSERT INTO search_watch_items (entity_key, item_id, kind, title, url, publisher, publisher_domain, source, lang, summary,\n"
               "                                published_at, first_seen_at) VALUES\n  " + ",\n  ".join(watch) + ";")
    for rows in (bundle, event):
        out.append("INSERT INTO observations (dataset, obs_date, entity, payload) VALUES\n  " + ",\n  ".join(rows) + ";")
    out.append(f"""INSERT INTO search_watches (user_id, entity_key, kind, name, aliases, ids)
SELECT id, {q(FEED_ENTITY)}, 'company', {q(FEED_WATCH_NAME)}, '[]'::jsonb, '{{"ticker": "NVDA", "market": "us"}}'::jsonb
FROM users WHERE role = 'OWNER' ORDER BY id LIMIT 1
ON CONFLICT (user_id, entity_key) DO NOTHING;""")
    out.append("COMMIT;")
    return out


def _observation_row(dataset: str, ident: str, payload: dict, seconds: int, *, link_key: str | None) -> str:
    """observations 한 행 — 작성 시각·처음 받은 시각은 넣는 순간에서 ``seconds`` 전(UTC ISO)으로 SQL이 채웁니다."""
    moment = f"now() - make_interval(secs => {seconds})"
    stamp = f"to_char(({moment}) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"+00:00\"')"
    body = q(json.dumps(payload, ensure_ascii=False))
    return (f"({q(dataset)}, (({moment}) AT TIME ZONE 'UTC')::date, {q(ident)}, "
            f"{body}::jsonb || jsonb_build_object('publishedAt', {stamp}, 'fetchedAt', {stamp}))")


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    rng = random.Random(SEED)
    if mode == "sql":
        print("\n".join(notice_sql(rng)))
    elif mode == "inventory":
        print("\n".join(inventory_tsv(rng)))
    elif mode == "feed":
        print("\n".join(feed_sql(random.Random(FEED_SEED))))
    else:
        print("사용: perf-seed.py sql | perf-seed.py inventory | perf-seed.py feed (자세한 것은 파일 머리 설명)", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
