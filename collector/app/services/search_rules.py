"""
app/services/search_rules.py
정보 검색(ADR 0041)의 규칙 — 계약 docs/specs/2026-11-14-info-search-contract.md §4가 원본으로 정한 것을 순수 함수로 둡니다(네트워크·DB 없음).

1. 2년 자르기: 창 시작 = 오늘(KST) − 2년의 날짜 00:00 KST. 작성 시각이 그보다 이르면 old(가장 최근 날짜를 기억 — ``olderOnlyLatest``),
   시각을 모르거나 지금 + 1일을 넘는 미래면 noTime.
2. 중국어 제목: 한글(가-힣)이나 가나(ぁ-ヿ)가 하나라도 있으면 남김. 아니면 한자(一-鿿) 2자 이상이고 한자 / (한자 + 라틴 글자) ≥ 0.3이면 뺌.
3. 매체 제외: 도메인이 '.cn'으로 끝나거나 목록의 도메인과 점 경계로 같거나, 매체 이름이 목록의 이름과 대소문자 무시 완전 일치면 뺌.
   목록의 처음 값은 진행 기록(2026-11-14-info-search-progress.md '매체 제외 목록의 처음 값')의 확실한 것만입니다. 이름이 다른 나라의 매체와
   겹치는 것(The Standard — 런던, Phoenix·SMM·The Paper 같은 일반 낱말)은 이름으로 빼지 않고 도메인으로만 뺍니다.
   2026-11-14 사용자 허용(ADR 0041 결정 6): 대만 매체, Investing.com, StreetInsider, South China Morning Post(자매 매체 Inkstone 포함),
   소유가 불확실했던 매체(Webull·Tiger·AInvest 등)는 목록에 넣지 않습니다(중국어 제목 거름과 '.cn' 규칙은 그대로 적용).
   사용자가 더하는 매체(단계 3 — 백엔드 표 search_media_excludes)는 :class:`Excludes`로 받아 처음 값에 더해 봅니다(읽기는 search_store, 60초 캐시).
4. 같은 글: 원문 주소가 있으면 ``info_text.item_id(url)``, 경유 주소(구글 뉴스)뿐이면 제목 앞 24자. 먼저 온 출처(우선순위 순)를 남깁니다.
5. 검색식: 따옴표 구문을 ' OR '로 묶음. 판마다 이름 + 네 글자 이상 별칭 최대 4개(긴 것 먼저), 티커는 넣지 않음.
6. 같은 사건 묶기(계약 §9-2 — 단계 6): 같은 언어(제목 글자로 가름)의 제목 낱말 집합(라틴 소문자 3글자 이상·불용어 제외, 한글 2글자 이상)의
   자카드 ≥ 0.5이고 시각 차이 ≤ 48시간이면 같은 묶음(시각순 단일 연결, 묶음 하나 최대 30줄, 모든 줄이 대표 줄로부터 48시간 안). 대표는 가장 이른 줄.
   공시·리서치·거장 견해 줄과 작성 시각을 모르는 줄(``timeBasis: fetched``)은 묶지 않습니다.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Sequence
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from . import info_text

KST = ZoneInfo("Asia/Seoul")
WINDOW_YEARS = 2
FUTURE_TOLERANCE = timedelta(days=1)
# 기간 단추(화면이 받은 2년 묶음에서 자름) — 시작은 그 날짜의 00:00 KST. 7d·30d는 오늘 − N일, 1y·2y는 오늘 − N년.
RANGE_DAYS = {"7d": 7, "30d": 30}
RANGE_YEARS = {"1y": 1, "2y": WINDOW_YEARS}
RANGE_KEYS = ("7d", "30d", "1y", "2y")

MIN_ALIAS_CHARS = 4          # 이보다 짧은 별칭은 자유 검색어·저장본 대조에 넣지 않음(이름은 짧아도 넣음)
MAX_ALIASES_PER_EDITION = 4
TITLE_KEY_CHARS = 24
SUMMARY_MAX_CHARS = 300
RELAY_HOSTS = frozenset({"news.google.com"})

_HANGUL = re.compile(r"[가-힣]")
_KANA = re.compile(r"[ぁ-ヿ]")
_HAN = re.compile(r"[一-鿿]")
_LATIN = re.compile(r"[A-Za-zÀ-ÖØ-öø-ɏ]")
_NON_LATIN_TEXT = re.compile(r"[^\x00-\x7fÀ-ÖØ-öø-ɏ]")
_MSN_TAIL = re.compile(r"\s+on\s+msn\s*$", re.IGNORECASE)
_PG_SPECIAL = re.compile(r"([\\^$.|?*+()\[\]{}])")

# ------------------------------------------------------------------ 매체 제외 목록(처음 값 — 진행 기록 2026-11-14, 사용자 허용 매체는 넣지 않음)
# (묶음 이름, 도메인, 이름) — 화면의 제외 목록(``/live/search/excludes``)이 묶음 이름과 함께 보입니다. 사용자가 더하는 매체는 백엔드 표
# search_media_excludes(단계 3)에 있고 :class:`Excludes`로 받아 이 목록에 더해 봅니다.
SEED_GROUPS: tuple[tuple[str, tuple[str, ...], tuple[str, ...]], ...] = (
    ("중국 국가·당 매체", (
        "xinhuanet.com", "news.cn", "chinadaily.com.cn", "chinadailyhk.com", "chinadailyasia.com", "globaltimes.cn",
        "people.cn", "people.com.cn", "peopledaily.com.cn", "cgtn.com", "cctv.com", "cri.cn", "ecns.cn", "chinanews.com.cn",
        "china.org.cn", "bjreview.com", "sixthtone.com", "thepaper.cn", "yicaiglobal.com", "yicai.com", "shine.cn",
        "shanghaidaily.com", "stcn.com", "cs.com.cn", "cnstock.com",
    ), (
        "Xinhua", "Xinhua News Agency", "Xinhuanet", "China Daily", "Global Times", "People's Daily", "People's Daily Online",
        "CGTN", "CCTV", "China Radio International", "China News Service", "China.org.cn", "Beijing Review", "Sixth Tone",
        "Yicai", "Yicai Global", "Shanghai Daily",
    )),
    ("중국 본토 민간 매체", (
        "caixinglobal.com", "caixin.com", "jiemian.com", "eeo.com.cn", "21jingji.com", "36kr.com", "technode.com", "pandaily.com",
        "mysteel.net", "mysteel.com", "metal.com", "gasgoo.com", "cnevpost.com", "carnewschina.com",
    ), (
        "Caixin", "Caixin Global", "Jiemian", "Economic Observer", "21st Century Business Herald", "36Kr", "TechNode", "Pandaily",
        "Mysteel", "Shanghai Metals Market", "Gasgoo", "CnEVPost", "CarNewsChina",
    )),
    ("홍콩 매체", (
        "thestandard.com.hk", "rthk.hk", "hongkongfp.com", "asiatimes.com", "ejinsight.com",
        "hkej.com", "hket.com", "aastocks.com", "etnet.com.hk", "mingtiandi.com", "dimsumdaily.hk", "ifeng.com", "weekinchina.com",
    ), (
        "RTHK", "Hong Kong Free Press", "HKFP", "Asia Times", "EJ Insight",
        "Hong Kong Economic Journal", "HKET", "Hong Kong Economic Times", "AASTOCKS", "ETNet", "Mingtiandi", "Dimsum Daily",
        "Phoenix New Media", "Week in China",
    )),
    ("마카오 매체", (
        "macaubusiness.com", "macaudailytimes.com.mo", "ggrasia.com", "asgam.com", "macaunews.mo",
    ), (
        "Macau Business", "Macau Daily Times", "GGRAsia", "Inside Asian Gaming", "Macau News Agency",
    )),
    ("중국 자본 금융 매체", (
        "moomoo.com", "futunn.com", "futuhk.com", "futuholdings.com",
    ), (
        "Futu", "Futubull", "moomoo",
    )),
    # '.cn' 규칙이 잡지 못하는 비중국 매체의 중국어 판
    ("비중국 매체의 중국어 판", ("ftchinese.com",), ()),
)
EXCLUDED_DOMAINS: frozenset[str] = frozenset(domain for _, domains, _ in SEED_GROUPS for domain in domains)
EXCLUDED_NAMES: frozenset[str] = frozenset(name for _, _, names in SEED_GROUPS for name in names)
# 목록과 상관없이 늘 적용하는 규칙(코드 고정 — ADR 0041 결정 6). 화면의 제외 목록에 함께 보입니다.
FIXED_RULES: tuple[str, ...] = ("제목이 중국어인 글(한글·가나가 있으면 남김)", "도메인이 .cn으로 끝나는 매체")
_EXCLUDED_NAME_KEYS = frozenset(name.casefold() for name in EXCLUDED_NAMES)


# ------------------------------------------------------------------ 시각

def kst_today(now: datetime | None = None) -> date:
    return (now or datetime.now(timezone.utc)).astimezone(KST).date()


def years_before(day: date, years: int) -> date:
    """``years``년 전의 같은 날(2월 29일은 2월 28일로)."""
    try:
        return day.replace(year=day.year - years)
    except ValueError:
        return day.replace(year=day.year - years, day=28)


def window(today: date) -> tuple[str, str]:
    """조회 창(KST 날짜) — (오늘 − 2년, 오늘)."""
    return years_before(today, WINDOW_YEARS).isoformat(), today.isoformat()


def kst_midnight(day: date) -> datetime:
    return datetime(day.year, day.month, day.day, tzinfo=KST)


def window_start(today: date) -> datetime:
    """창 시작 시각 — 오늘 − 2년의 00:00 KST."""
    return kst_midnight(years_before(today, WINDOW_YEARS))


def range_starts(today: date) -> dict[str, str]:
    """기간 단추마다 시작 시각(UTC ISO) — 그 시각 이후(같은 시각 포함)의 줄을 그 기간에 셉니다."""
    out = {key: utc_iso(kst_midnight(today - timedelta(days=days))) for key, days in RANGE_DAYS.items()}
    out.update({key: utc_iso(kst_midnight(years_before(today, years))) for key, years in RANGE_YEARS.items()})
    return {key: out[key] for key in RANGE_KEYS}


def utc_iso(moment: datetime) -> str:
    """UTC ISO(``YYYY-MM-DDTHH:MM:SS+00:00``) — 문자열 정렬이 시간 순서와 같습니다. 시간대가 없으면 UTC로 봅니다."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds")


def parse_time(value: Any) -> datetime | None:
    """ISO 문자열('Z' 포함)·epoch 초·datetime → UTC datetime. 읽지 못하면 None(지어내지 않음)."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, datetime):
        moment = value
    elif isinstance(value, (int, float)):
        if not math.isfinite(value):
            return None
        try:
            return datetime.fromtimestamp(value, timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text.endswith(("Z", "z")):
            text = text[:-1] + "+00:00"
        try:
            moment = datetime.fromisoformat(text)
        except ValueError:
            return None
    else:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def time_verdict(published: datetime | None, *, start: datetime, now: datetime) -> str:
    """'ok' · 'old'(창 시작보다 이름) · 'noTime'(모름 또는 지금 + 1일 넘는 미래)."""
    if published is None or published > now + FUTURE_TOLERANCE:
        return "noTime"
    return "old" if published < start else "ok"


# ------------------------------------------------------------------ 중국어 제목

def has_hangul(text: str | None) -> bool:
    return bool(text) and bool(_HANGUL.search(text))


def is_chinese_title(title: str | None) -> bool:
    """중국어 제목인가 — 한글·가나가 있으면 아님(한국어·일본어), 아니면 한자 2자 이상이고 한자/(한자+라틴) ≥ 0.3."""
    if not title or _HANGUL.search(title) or _KANA.search(title):
        return False
    han = len(_HAN.findall(title))
    if han < 2:
        return False
    latin = len(_LATIN.findall(title))
    return han / (han + latin) >= 0.3


# ------------------------------------------------------------------ 매체 제외

def domain_of(url: str | None) -> str | None:
    """주소의 호스트(소문자, 앞의 www. 없음). http(s)가 아니거나 호스트가 없으면 None."""
    if not url:
        return None
    try:
        parts = urlsplit(str(url).strip())
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https"):
        return None
    host = (parts.hostname or "").lower().rstrip(".")
    if host.startswith("www."):
        host = host[4:]
    return host or None


def ascii_host(host: str) -> str:
    """
    국제화 도메인 → punycode(``xn--``) — 화면·백엔드가 제외 도메인을 이 모양으로 저장합니다(Java ``IDN.toASCII``, Python ``idna`` 코덱과 같은
    IDNA2003). ASCII 호스트는 그대로, 바꾸지 못하면 그대로 돌려줍니다.
    """
    if host.isascii():
        return host
    try:
        return host.encode("idna").decode("ascii")
    except (UnicodeError, ValueError):
        return host


def normalize_domain(value: str | None) -> str | None:
    """제외 목록의 도메인 값 → 소문자 ASCII 호스트(앞의 www.·끝의 점 없음, 국제화 도메인은 punycode). 주소를 넣었으면 그 호스트. 비었으면 None."""
    text = (value or "").strip()
    if "://" in text:
        host = domain_of(text)
        return ascii_host(host) if host else None
    host = text.lower().rstrip(".").split("/", 1)[0]
    if host.startswith("www."):
        host = host[4:]
    return ascii_host(host) if host else None


def media_name_key(name: str | None) -> str:
    """매체 이름 대조 키 — MSN 재게재 꼬리('on MSN')를 떼고 대소문자를 무시합니다."""
    return _MSN_TAIL.sub("", (name or "").strip()).strip().casefold()


@dataclass(frozen=True)
class Excludes:
    """사용자가 더한 제외 매체(백엔드 표 search_media_excludes) — 도메인(소문자 호스트)과 이름 대조 키."""

    domains: frozenset[str] = frozenset()
    names: frozenset[str] = frozenset()


def make_excludes(rows: Iterable[dict]) -> Excludes:
    """표의 행([{kind, value}]) → :class:`Excludes`. 모르는 종류·빈 값은 건너뜁니다."""
    domains: set[str] = set()
    names: set[str] = set()
    for row in rows or []:
        kind, value = row.get("kind"), row.get("value")
        if not isinstance(value, str):
            continue
        if kind == "domain":
            host = normalize_domain(value)
            if host:
                domains.add(host)
        elif kind == "name":
            key = media_name_key(value)
            if key:
                names.add(key)
    return Excludes(frozenset(domains), frozenset(names))


def is_excluded_media(domain: str | None, name: str | None, extra: Excludes | None = None) -> bool:
    """
    제외할 매체인가(규칙 3) — '.cn' 도메인, 목록 도메인(점 경계, 국제화 도메인은 punycode로 맞춰 봄), 목록 이름(대소문자 무시 완전 일치, MSN
    재게재 꼬리는 뗌).
    ``extra``는 사용자가 더한 매체(처음 값 목록에 더해 봄).
    """
    host = ascii_host((domain or "").strip().lower().rstrip("."))
    if host.startswith("www."):
        host = host[4:]
    if host:
        if host.endswith(".cn"):
            return True
        if any(host == excluded or host.endswith("." + excluded) for excluded in EXCLUDED_DOMAINS):
            return True
        if extra is not None and any(host == excluded or host.endswith("." + excluded) for excluded in extra.domains):
            return True
    if name:
        key = media_name_key(name)
        if key in _EXCLUDED_NAME_KEYS or (extra is not None and key in extra.names):
            return True
    return False


def seed_list() -> list[dict]:
    """처음 값 목록 → [{kind(domain·name), value, group}](묶음 순서, 묶음 안은 도메인 먼저). 화면의 제외 목록용."""
    out: list[dict] = []
    for group, domains, names in SEED_GROUPS:
        out += [{"kind": "domain", "value": domain, "group": group} for domain in domains]
        out += [{"kind": "name", "value": name, "group": group} for name in names]
    return out


# ------------------------------------------------------------------ 같은 글

def same_ticker(left: str, right: str) -> bool:
    """같은 티커인가 — 'BRK.B'와 'BRK-B'를 같게 봅니다."""
    return left.upper().replace(".", "-") == right.upper().replace(".", "-")


def title_key(title: str | None) -> str:
    return re.sub(r"\W+", "", (title or "").lower())[:TITLE_KEY_CHARS]


def is_relay(url: str | None) -> bool:
    return domain_of(url) in RELAY_HOSTS


def item_key(url: str | None, title: str | None) -> str:
    """같은 글 가리기 키 — 원문 주소면 ``info_text.item_id``, 경유 주소(구글)뿐이거나 주소가 없으면 제목 앞 24자."""
    if url and domain_of(url) and not is_relay(url):
        return info_text.item_id(url)
    return title_key(title)


def merge(groups: Iterable[Sequence[dict]]) -> list[dict]:
    """
    출처 묶음(우선순위 높은 것부터)을 합쳐 최신순으로 — 같은 키는 먼저 온 하나만. 경유 주소 줄은 앞서 남은 어느 줄과도 제목 앞 24자가
    같으면 뺍니다(우선순위가 가장 낮은 구글 줄이 원문 주소를 가진 같은 기사와 겹치지 않게).
    """
    seen_ids: set[str] = set()
    seen_titles: set[str] = set()
    merged: list[dict] = []
    for group in groups:
        for item in group:
            key = item.get("id") or item_key(item.get("url"), item.get("title"))
            title = title_key(item.get("title"))
            if not key or key in seen_ids:
                continue
            if title and (is_relay(item.get("url")) or not item.get("url")) and title in seen_titles:
                continue
            seen_ids.add(key)
            if title:
                seen_titles.add(title)
            merged.append(item)
    merged.sort(key=lambda item: (item.get("publishedAt") or "", item.get("id") or ""), reverse=True)
    return merged


# ------------------------------------------------------------------ 규칙 적용

def empty_dropped() -> dict[str, int]:
    return {"old": 0, "noTime": 0, "chinese": 0, "excluded": 0}


def apply_rules(items: Iterable[dict], *, start: datetime, now: datetime,
                excludes: Excludes | None = None) -> tuple[list[dict], dict[str, int], str | None]:
    """
    매체 제외(처음 값 + ``excludes`` — 사용자가 더한 매체) → 중국어 제목 → 시각(2년·모름·미래) 순으로 가립니다. 한 줄은 한 번만 셉니다.

    :returns: (남은 줄, 뺀 건수, 창보다 오래된 줄 가운데 가장 최근 날짜(KST, 없으면 None))
    """
    kept: list[dict] = []
    dropped = empty_dropped()
    latest_old: datetime | None = None
    for item in items:
        if is_excluded_media(item.get("publisherDomain"), item.get("publisher"), excludes):
            dropped["excluded"] += 1
            continue
        if is_chinese_title(item.get("title")):
            dropped["chinese"] += 1
            continue
        published = parse_time(item.get("publishedAt"))
        verdict = time_verdict(published, start=start, now=now)
        if verdict == "noTime":
            dropped["noTime"] += 1
            continue
        if verdict == "old":
            dropped["old"] += 1
            latest_old = published if latest_old is None or published > latest_old else latest_old
            continue
        kept.append(dict(item, publishedAt=utc_iso(published)))
    return kept, dropped, latest_old.astimezone(KST).date().isoformat() if latest_old else None


def range_counts(items: Iterable[dict], today: date) -> dict[str, int]:
    """받은 자료(규칙을 거친 줄) 기준 기간별 건수."""
    starts = range_starts(today)
    counts = {key: 0 for key in RANGE_KEYS}
    for item in items:
        stamp = item.get("publishedAt") or ""
        for key in RANGE_KEYS:
            if stamp >= starts[key]:
                counts[key] += 1
    return counts


# ------------------------------------------------------------------ 같은 사건 묶기(계약 §9-2 — 단계 6)

CLUSTER_MIN_JACCARD = 0.5
CLUSTER_WINDOW = timedelta(hours=48)
CLUSTER_MAX_ROWS = 30
CLUSTER_MIN_SHARED = 2          # 대상 이름 낱말을 뺀 뒤 겹친 낱말이 이만큼은 있어야 같은 사건(낱말 하나로 묶지 않음)
# 묶는 줄의 종류 — 공시·리서치 줄은 문서 그 자체라(서식 이름·투자의견 꼴의 같은 제목이 서로 다른 문서) 묶지 않습니다. 거장 견해(opinion)도
# '<이름> 시장 견해 — <입장> <점수>' 틀의 제목에 한 스냅숏의 거장이 모두 같은 기준일이라, 서로 다른 거장의 견해가 틀 낱말만으로 묶이므로 뺍니다.
CLUSTER_KINDS = frozenset({"news", "headline", "post", "wire"})
MIN_LATIN_WORD = 3
MIN_HANGUL_WORD = 2
# 영어 제목에 흔한 기능어(3글자 이상만 — 그보다 짧은 낱말은 길이로 빠짐).
STOPWORDS = frozenset({
    "the", "and", "for", "with", "from", "into", "onto", "over", "under", "after", "before", "about", "amid", "against",
    "that", "this", "these", "those", "than", "then", "there", "here", "what", "why", "how", "who", "whom", "when", "where",
    "which", "while", "are", "was", "were", "been", "being", "has", "have", "had", "does", "did", "will", "would", "could",
    "should", "can", "may", "might", "its", "his", "her", "their", "our", "your", "you", "they", "not", "but", "all", "any",
    "more", "most", "new", "now", "out", "off", "per", "via", "just", "also", "says", "said", "get", "gets",
})
_LATIN_WORD = re.compile(r"[0-9a-zà-öø-ɏ]+")
_LATIN_LOWER = re.compile(r"[a-zà-öø-ɏ]")
_HANGUL_WORD = re.compile(r"[가-힣]+")


def title_tokens(title: str | None) -> frozenset[str]:
    """
    제목의 낱말 집합 — 라틴 글자 낱말(소문자, 3글자 이상이고 글자가 하나 이상 — 숫자만인 낱말은 아님, 불용어 제외)과 한글 낱말(2글자 이상).
    낱말은 그 글자가 이어진 덩어리입니다('NVIDIA's' → nvidia, 'SK하이닉스' → 하이닉스, 'HBM4' → hbm4).
    """
    if not title:
        return frozenset()
    folded = title.casefold()
    latin = {word for word in _LATIN_WORD.findall(folded)
             if len(word) >= MIN_LATIN_WORD and _LATIN_LOWER.search(word) and word not in STOPWORDS}
    hangul = {word for word in _HANGUL_WORD.findall(folded) if len(word) >= MIN_HANGUL_WORD}
    return frozenset(latin | hangul)


def title_lang(title: str | None) -> str | None:
    """
    묶기에 쓰는 제목 언어 — 한글이 있으면 'ko', 가나가 있으면 None(일본어 — 묶지 않음), 라틴 글자가 있으면 'en', 그 밖은 None.
    줄의 ``lang`` 칸은 출처의 판(구글 한국어 판에도 영어 제목이 옴)이라 제목 글자로 가릅니다(search_store의 언어 가르기와 같은 뜻).
    """
    if not title:
        return None
    if _HANGUL.search(title):
        return "ko"
    if _KANA.search(title):
        return None
    return "en" if _LATIN.search(title) else None


def jaccard(left: frozenset[str], right: frozenset[str]) -> float:
    """두 낱말 집합의 자카드 유사도(겹친 수 / 합친 수). 한쪽이 비면 0."""
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def _prefix_size(count: int) -> int:
    """
    앞부분 거르기(prefix filter)의 길이 — 모든 집합의 낱말을 같은 순서(드문 낱말 먼저)로 세웠을 때, 자카드 ≥ t인 두 집합은 각자의 앞
    ``n − ⌈t·n⌉ + 1``개 안에서 낱말 하나 이상을 함께 가집니다. 그 앞부분만 색인해 후보를 고르고 유사도는 전부로 다시 잽니다.
    """
    return count - math.ceil(CLUSTER_MIN_JACCARD * count - 1e-9) + 1


def _publisher_count(rows: Iterable[dict]) -> int | None:
    """
    묶음의 서로 다른 매체 수 — 매체 이름(대소문자 무시, MSN 재게재 꼬리 뗌)으로 세고, 이름이 없는 줄은 매체 도메인으로 셉니다. 이름 없는 줄의 도메인을
    묶음 안에서 이름 하나만 썼으면 그 매체로 봅니다. 매체를 하나도 모르면 None(0이 아님).
    """
    names: set[str] = set()
    names_by_domain: dict[str, set[str]] = {}
    bare_domains: set[str] = set()
    for row in rows:
        name = media_name_key(row.get("publisher"))
        domain = (row.get("publisherDomain") or "").strip().lower() or None
        if name:
            names.add(name)
            if domain:
                names_by_domain.setdefault(domain, set()).add(name)
        elif domain:
            bare_domains.add(domain)
    unnamed = {domain for domain in bare_domains if len(names_by_domain.get(domain, ())) != 1}
    return (len(names) + len(unnamed)) or None


def cluster_items(items: Sequence[dict], *, ignore: Iterable[str] = ()) -> list[dict]:
    """
    같은 사건 묶기(계약 §9-2) — 같은 언어의 제목 낱말 집합 자카드 ≥ 0.5이고 작성 시각 차이 ≤ 48시간이면 같은 묶음입니다. 줄을 이른 시각부터
    차례로 보며(시각순 단일 연결) 앞선 줄 하나와 이어지면 그 줄의 묶음에 들고, 여러 묶음과 이어지면 그 묶음들을 하나로 합칩니다(대표가 가장 이른
    묶음으로 — 합친 크기가 상한을 넘는 묶음은 따로 둠). 묶음 하나는 최대 30줄이고, 모든 줄이 대표 줄(가장 이른 줄)로부터 48시간 안이어야
    합니다(매일 같은 꼴의 제목이 사슬로 한 달치 이어지지 않게). 꽉 찬 묶음과만 이어지는 줄은 새 묶음을 엽니다.

    ``ignore``(대상의 이름·별칭 — :func:`match_terms`)의 낱말은 재기 전에 제목 낱말에서 뺍니다: 대상별 결과는 거의 모든 제목에 대상 이름이
    있어, 이름 낱말이 공통분모가 되면 'Nvidia shares rise'와 '… fall' 같은 반대 사건이 0.5로 묶입니다. 뺀 뒤 겹친 낱말이
    :data:`CLUSTER_MIN_SHARED` 미만이면 자카드와 상관없이 묶지 않습니다.

    묶는 줄은 :data:`CLUSTER_KINDS`이고 id·작성 시각·제목 언어·낱말이 모두 있는 줄만입니다 — ``timeBasis``가 ``fetched``(처음 받은 시각)인 줄은
    작성 시각을 모르므로 묶지 않습니다. 순서는 그대로 두고 줄마다 새 사전에 ``clusterId``(대표 줄의
    ``id``, 묶이지 않으면 None)와 ``cluster``(대표 줄에만 ``{size, publishers}``, 그 밖은 None)를 더해 돌려줍니다. 줄을 빼지 않으므로 기간 건수·
    출처 건수는 그대로입니다.
    """
    rows = list(items)
    skip: set[str] = set()
    for term in ignore or ():
        skip |= title_tokens(term)
    entries: list[tuple[float, str, int, str, frozenset[str]]] = []
    for index, item in enumerate(rows):
        if item.get("kind") not in CLUSTER_KINDS or not item.get("id") or item.get("timeBasis") == "fetched":
            continue
        moment = parse_time(item.get("publishedAt"))
        lang = title_lang(item.get("title"))
        tokens = title_tokens(item.get("title")) - skip
        if moment is None or lang is None or len(tokens) < CLUSTER_MIN_SHARED:
            continue
        entries.append((moment.timestamp(), str(item["id"]), index, lang, tokens))
    entries.sort(key=lambda entry: (entry[0], entry[1], entry[2]))

    frequency: dict[str, int] = {}
    for entry in entries:
        for token in entry[4]:
            frequency[token] = frequency.get(token, 0) + 1
    window_seconds = CLUSTER_WINDOW.total_seconds()
    parent = list(range(len(entries)))
    size = [1] * len(entries)
    postings: dict[tuple[str, str], list[int]] = {}      # (언어, 앞부분 낱말) → 그 낱말을 앞부분에 가진 앞선 줄(시각순)

    def find(position: int) -> int:
        while parent[position] != position:
            parent[position] = parent[parent[position]]
            position = parent[position]
        return position

    for position, (stamp, _, _, lang, tokens) in enumerate(entries):
        ordered = sorted(tokens, key=lambda token: (frequency[token], token))
        prefix = ordered[:_prefix_size(len(ordered))]
        linked: set[int] = set()
        examined: set[int] = set()
        for token in prefix:
            earlier = postings.get((lang, token), [])
            for other in reversed(earlier):
                if stamp - entries[other][0] > window_seconds:
                    break
                if other in examined:
                    continue
                examined.add(other)
                root = find(other)
                if root in linked or size[root] >= CLUSTER_MAX_ROWS or stamp - entries[root][0] > window_seconds:
                    continue
                theirs = entries[other][4]
                if len(tokens & theirs) >= CLUSTER_MIN_SHARED and jaccard(tokens, theirs) >= CLUSTER_MIN_JACCARD:
                    linked.add(root)
        if linked:
            roots = sorted(linked)                       # 자리 = 시각순 — 대표가 가장 이른 묶음이 앞
            target = roots[0]
            parent[position] = target
            size[target] += 1
            for root in roots[1:]:
                if size[target] + size[root] <= CLUSTER_MAX_ROWS:
                    parent[root] = target
                    size[target] += size[root]
        for token in prefix:
            postings.setdefault((lang, token), []).append(position)

    members: dict[int, list[int]] = {}
    for position in range(len(entries)):
        members.setdefault(find(position), []).append(position)
    lead_of: dict[int, str] = {}
    summary: dict[int, dict] = {}
    for root, group in members.items():
        if len(group) < 2:
            continue
        lead_id = entries[root][1]
        for position in group:
            lead_of[entries[position][2]] = lead_id
        summary[entries[root][2]] = {"size": len(group),
                                     "publishers": _publisher_count(rows[entries[position][2]] for position in group)}
    return [dict(item, clusterId=lead_of.get(index), cluster=summary.get(index)) for index, item in enumerate(rows)]


# ------------------------------------------------------------------ 검색식·대조

def _is_latin_term(term: str) -> bool:
    return not _NON_LATIN_TEXT.search(term)


def usable_alias(alias: str, ticker: str | None) -> bool:
    text = alias.strip()
    if len(text) < MIN_ALIAS_CHARS:
        return False
    if ticker and text.casefold() == ticker.casefold():
        return False
    return not (_HAN.search(text) and not _HANGUL.search(text))      # 중국어 별칭은 쓰지 않음


def dedupe_texts(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out = []
    for value in values:
        text = (value or "").strip()
        if text and text.casefold() not in seen:
            seen.add(text.casefold())
            out.append(text)
    return out


def _names(entity: dict) -> list[str]:
    ticker = ((entity.get("ids") or {}).get("ticker") or "").casefold()
    names = dedupe_texts([entity.get("nameKo") or "", entity.get("nameEn") or "", entity.get("name") or ""])
    return [name for name in names if name.casefold() != ticker and not (_HAN.search(name) and not _HANGUL.search(name))]


def edition_terms(entity: dict, lang: str) -> list[str]:
    """
    한 판(ko·en)의 검색어 — 그 판 글자의 이름 전부 + 네 글자 이상 별칭 최대 4개(긴 것 먼저). 티커·중국어는 넣지 않습니다.
    한국어 판은 한글이 든 이름·별칭, 영어 판은 한글이 없는 라틴 글자 이름·별칭입니다.
    """
    def fits(text: str) -> bool:
        return has_hangul(text) if lang == "ko" else (not has_hangul(text) and _is_latin_term(text))

    ticker = (entity.get("ids") or {}).get("ticker")
    names = [name for name in _names(entity) if fits(name)]
    taken = {name.casefold() for name in names}
    aliases = [alias for alias in dedupe_texts(entity.get("aliases") or [])
               if fits(alias) and alias.casefold() not in taken and usable_alias(alias, ticker)]
    aliases.sort(key=len, reverse=True)
    return names + aliases[:MAX_ALIASES_PER_EDITION]


def match_terms(entity: dict) -> list[str]:
    """저장본(사건 뉴스·수집 글·거장 견해) 대조어 — 이름 전부 + 네 글자 이상 별칭(티커·중국어 없음)."""
    ticker = (entity.get("ids") or {}).get("ticker")
    names = _names(entity)
    taken = {name.casefold() for name in names}
    aliases = [alias for alias in dedupe_texts(entity.get("aliases") or [])
               if alias.casefold() not in taken and usable_alias(alias, ticker)]
    return names + aliases


def build_query(terms: Sequence[str], *, after: str | None = None, site: str | None = None) -> str | None:
    """따옴표 구문을 ' OR '로 — 구문 안의 따옴표는 지웁니다. 검색어가 없으면 None."""
    phrases = [f'"{" ".join(term.replace(chr(34), "").split())}"' for term in terms if term and term.replace('"', "").strip()]
    if not phrases:
        return None
    query = " OR ".join(phrases)
    if site:
        query += f" site:{site}"
    if after:
        query += f" after:{after}"
    return query


def _latin_pattern(term: str) -> re.Pattern:
    return re.compile(r"(?<![0-9a-z])" + re.escape(term.casefold()) + r"(?![0-9a-z])")


def text_matches(text: str | None, terms: Sequence[str]) -> bool:
    """대조 — 라틴 글자 별칭은 단어 경계(대소문자 무시), 그 밖(한글 등)은 포함."""
    if not text or not terms:
        return False
    folded = text.casefold()
    for term in terms:
        if _is_latin_term(term):
            if _latin_pattern(term).search(folded):
                return True
        elif term.casefold() in folded:
            return True
    return False


def sql_patterns(terms: Sequence[str]) -> tuple[list[str], list[str]]:
    """DB 대조식 — (ILIKE 패턴(한글 등 포함 대조), ``~*`` 정규식(라틴 글자 단어 경계)). text_matches와 같은 뜻입니다."""
    ilike: list[str] = []
    regex: list[str] = []
    for term in terms:
        if _is_latin_term(term):
            regex.append("(^|[^0-9a-z])" + _PG_SPECIAL.sub(r"\\\1", term.casefold()) + "([^0-9a-z]|$)")
        else:
            escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            ilike.append(f"%{escaped}%")
    return ilike, regex


def clip(text: str | None, limit: int = SUMMARY_MAX_CHARS) -> str | None:
    """요약 상한(글자) — 넘으면 자르고 '…'."""
    value = " ".join((text or "").split())
    if not value:
        return None
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"
