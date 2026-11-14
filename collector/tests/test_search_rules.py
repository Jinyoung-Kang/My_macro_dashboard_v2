"""
tests/test_search_rules.py
정보 검색(ADR 0041, 계약 docs/specs/2026-11-14-info-search-contract.md §4)의 규칙 — 네트워크·DB 없이 순수 함수만 봅니다.

- 2년 자르기: 창 시작 = 오늘(KST) − 2년의 00:00 KST, 이른 줄은 old(가장 최근 날짜 기억), 모름·미래(+1일 넘음)는 noTime
- 중국어 제목: 한글·가나가 있으면 남김, 아니면 한자 2자 이상이고 한자/(한자+라틴) ≥ 0.3이면 뺌
- 매체 제외: '.cn'·목록 도메인(점 경계)·이름(대소문자 무시 완전 일치)
- 같은 글: 원문 주소는 info_text.item_id, 경유 주소(구글)는 제목 앞 24자, 우선순위 높은 출처가 남음
- 검색식: 따옴표 구문을 ' OR '로, 네 글자 미만 별칭·티커는 빼고 판마다 별칭 4개(긴 것 먼저)
- 기간별 건수(7d·30d·1y·2y)와 최신순 정렬(UTC ISO 문자열)
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from app.services import info_text
from app.services import search_rules as rules

KST = ZoneInfo("Asia/Seoul")
NOW = datetime(2026, 11, 14, 3, 0, tzinfo=timezone.utc)          # 2026-11-14 12:00 KST
TODAY = date(2026, 11, 14)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds")


def _item(title="합성 제목", *, url="https://example.org/a", published=None, domain="example.org", publisher="Example",
          source="bing", basis="published"):
    return {"id": rules.item_key(url, title), "kind": "news", "title": title, "url": url, "publisher": publisher,
            "publisherDomain": domain, "publishedAt": published, "timeBasis": basis, "source": source, "lang": "en",
            "summary": None, "readerId": None}


# ------------------------------------------------------------------ 2년 창

def test_오늘은_KST_날짜다():
    assert rules.kst_today(datetime(2026, 11, 13, 15, 30, tzinfo=timezone.utc)) == date(2026, 11, 14)
    assert rules.kst_today(datetime(2026, 11, 13, 14, 59, tzinfo=timezone.utc)) == date(2026, 11, 13)


def test_창은_오늘부터_2년_전_00시_KST():
    assert rules.window(TODAY) == ("2024-11-14", "2026-11-14")
    start = rules.window_start(TODAY)
    assert start == datetime(2024, 11, 14, tzinfo=KST)
    assert _iso(start) == "2024-11-13T15:00:00+00:00"


def test_윤일의_2년_전은_2월_28일():
    assert rules.years_before(date(2028, 2, 29), 2) == date(2026, 2, 28)
    assert rules.window(date(2028, 2, 29))[0] == "2026-02-28"


def test_시각_가르기_old·noTime·미래():
    start = rules.window_start(TODAY)
    assert rules.time_verdict(None, start=start, now=NOW) == "noTime"
    assert rules.time_verdict(NOW + timedelta(days=1, minutes=1), start=start, now=NOW) == "noTime", "미래 1일 넘음은 시각 모름"
    assert rules.time_verdict(NOW + timedelta(hours=23), start=start, now=NOW) == "ok"
    assert rules.time_verdict(start, start=start, now=NOW) == "ok", "창 시작 시각 그 자체는 안"
    assert rules.time_verdict(start - timedelta(seconds=1), start=start, now=NOW) == "old"


def test_시각_읽기는_ISO·epoch·datetime을_UTC로():
    assert rules.parse_time("2026-11-13T07:00:00+00:00") == datetime(2026, 11, 13, 7, tzinfo=timezone.utc)
    assert rules.parse_time("2026-11-13T16:00:00+09:00") == datetime(2026, 11, 13, 7, tzinfo=timezone.utc)
    assert rules.parse_time("2026-11-13T07:00:00Z") == datetime(2026, 11, 13, 7, tzinfo=timezone.utc)
    assert rules.parse_time(1_794_553_200) == datetime.fromtimestamp(1_794_553_200, timezone.utc)
    assert rules.parse_time(datetime(2026, 11, 13, 16, 0, tzinfo=KST)) == datetime(2026, 11, 13, 7, tzinfo=timezone.utc)
    for bad in (None, "", "어제", "2026-13-40", True, float("nan")):
        assert rules.parse_time(bad) is None
    assert rules.utc_iso(datetime(2026, 11, 13, 16, 0, tzinfo=KST)) == "2026-11-13T07:00:00+00:00"


# ------------------------------------------------------------------ 중국어 제목

@pytest.mark.parametrize("title", [
    "이재용 회장, 日 R&D 거점 방문",          # 한국어 제목의 한자 한 글자
    "李 대통령, 美中 정상과 통화",             # 한국어 제목의 한자 여럿 — 한글이 있으면 남김
    "トヨタ、新型EVを発表",                    # 일본어(가나)
    "日経平均が反発、半導体株に買い",           # 일본어 — 가나가 하나라도 있으면 남김
    "Nvidia beats estimates as AI demand surges",
    "Samsung (三星) unveils new chip lineup for 2027 data centers",   # 영어 제목 안의 한자 2자 — 비율이 낮음
    "中",                                     # 한자 한 글자뿐 — 2자 미만
])
def test_중국어가_아닌_제목은_남는다(title):
    assert rules.is_chinese_title(title) is False


@pytest.mark.parametrize("title", [
    "英伟达发布新一代芯片",
    "三星电子第三季度利润大增 AI",
    "港股收盘 恒生指数涨1%",
    "華爾街日報：美聯儲官員暗示降息",
])
def test_중국어_제목은_빠진다(title):
    assert rules.is_chinese_title(title) is True


def test_중국어_판별의_경계값():
    # 한자 3 / (한자 3 + 라틴 7) = 0.3 → 뺌, 라틴 8이면 0.27 → 남김
    assert rules.is_chinese_title("中国股 abcdefg") is True
    assert rules.is_chinese_title("中国股 abcdefgh") is False
    assert rules.is_chinese_title("") is False and rules.is_chinese_title(None) is False


# ------------------------------------------------------------------ 매체 제외

@pytest.mark.parametrize("domain,name", [
    ("news.cn", None),
    ("www.chinadaily.com.cn", None),
    ("anything.cn", None),
    ("xinhuanet.com", None),
    ("english.news.cn", None),
    ("www.caixinglobal.com", None),
    ("thestandard.com.hk", None),
    ("www.moomoo.com", None),
    ("ftchinese.com", None),
    (None, "Xinhua"),
    ("finance.yahoo.com", "global times"),        # 이름은 대소문자 무시 완전 일치
    ("msn.com", "Caixin Global on MSN"),          # MSN 재게재 꼬리는 떼고 대조
    (None, "moomoo"),
    (None, "Hong Kong Free Press"),
])
def test_제외_매체(domain, name):
    assert rules.is_excluded_media(domain, name) is True


@pytest.mark.parametrize("domain,name", [
    ("reuters.com", "Reuters"),
    ("notxinhuanet.com", None),                   # 점 경계 — 'xinhuanet.com'으로 끝나도 다른 도메인
    ("xinhuanet.com.example.org", None),
    ("cnbc.com", "CNBC"),
    ("channelnewsasia.com", "CNA"),               # 이름이 겹치는 다른 매체(싱가포르 CNA)는 이름으로 빼지 않음
    ("standard.co.uk", "The Standard"),           # 런던 The Standard — 홍콩 The Standard는 도메인으로만
    (None, "Xinhua News"),                        # 완전 일치만
    (None, None),
])
def test_제외하지_않는_매체(domain, name):
    assert rules.is_excluded_media(domain, name) is False


# 2026-11-14 사용자 허용(ADR 0041 결정 6, 진행 기록 '사용자가 허용함') — 대만 매체·Investing.com·StreetInsider·
# South China Morning Post(자매 매체 Inkstone 포함)·소유가 불확실했던 매체는 제외 목록에 넣지 않습니다.
@pytest.mark.parametrize("domain,name", [
    ("investing.com", "Investing.com"),
    ("in.investing.com", None),
    ("msn.com", "Investing.com on MSN"),
    ("streetinsider.com", "StreetInsider"),
    ("www.scmp.com", "South China Morning Post"),
    (None, "SCMP"),
    ("inkstonenews.com", "Inkstone"),
    ("focustaiwan.tw", "Focus Taiwan"),
    ("cna.com.tw", None),
    ("taipeitimes.com", "Taipei Times"),
    ("taiwannews.com.tw", "Taiwan News"),
    ("digitimes.com", "DigiTimes"),
    ("trendforce.com", "TrendForce"),
    ("cw.com.tw", "CommonWealth Magazine"),
    ("rti.org.tw", "Radio Taiwan International"),
    ("chinapost.com.tw", "The China Post"),
    ("finance.biggo.com", "BigGo Finance"),
    ("webull.com", "Webull"),
    ("ainvest.com", "AInvest"),
])
def test_사용자가_허용한_매체는_빼지_않는다(domain, name):
    assert rules.is_excluded_media(domain, name) is False


def test_제외_목록은_진행_기록의_처음_값을_담는다():
    for domain in ("xinhuanet.com", "globaltimes.cn", "people.com.cn", "cgtn.com", "caixinglobal.com", "36kr.com", "hket.com",
                   "macaubusiness.com", "futunn.com", "moomoo.com", "ftchinese.com"):
        assert domain in rules.EXCLUDED_DOMAINS, domain
    for allowed in ("scmp.com", "inkstonenews.com", "investing.com", "streetinsider.com", "taipeitimes.com", "trendforce.com",
                    "digitimes.com", "focustaiwan.tw", "biggo.com"):
        assert allowed not in rules.EXCLUDED_DOMAINS, allowed
    assert not [d for d in rules.EXCLUDED_DOMAINS if d.endswith(".tw")], "대만 도메인은 넣지 않음"
    assert all(d == d.lower() and not d.startswith("www.") for d in rules.EXCLUDED_DOMAINS)
    names = {name.casefold() for name in rules.EXCLUDED_NAMES}
    assert "cna" not in names and "the standard" not in names
    assert not names & {"investing.com", "streetinsider", "south china morning post", "scmp", "inkstone", "digitimes", "biggo"}


def test_도메인_정규화():
    assert rules.domain_of("https://WWW.Reuters.com/markets/x?y=1") == "reuters.com"
    assert rules.domain_of("https://news.google.com/rss/articles/abc") == "news.google.com"
    assert rules.domain_of("javascript:alert(1)") is None
    assert rules.domain_of(None) is None and rules.domain_of("") is None


# ------------------------------------------------------------------ 같은 글

def test_같은_글_키는_원문_주소면_item_id_경유_주소면_제목_24자():
    url = "https://www.example.org/news/a1/?utm_source=x"
    assert rules.item_key(url, "아무 제목") == info_text.item_id(url)
    relay = "https://news.google.com/rss/articles/CBMiXyz?oc=5"
    assert rules.item_key(relay, "Nvidia, Beats! Estimates: as AI demand surges") == "nvidiabeatsestimatesasai"
    assert rules.item_key(None, "제목만 있는 글") == "제목만있는글"


def test_합치기는_우선순위가_높은_출처를_남기고_최신순():
    stored = _item("Nvidia beats estimates as AI demand surges", url="https://www.example.org/a1",
                   published="2026-11-13T07:00:00+00:00", source="event_news")
    bing_same_url = _item("Nvidia beats estimates (updated)", url="https://example.org/a1/?utm_medium=rss",
                          published="2026-11-13T08:00:00+00:00", source="bing")
    google_same_title = _item("Nvidia beats estimates as AI demand surges further", url="https://news.google.com/rss/articles/Z",
                              published="2026-11-13T09:00:00+00:00", source="google_en")
    google_other = _item("Different story", url="https://news.google.com/rss/articles/Q",
                         published="2026-11-12T09:00:00+00:00", source="google_en")
    merged = rules.merge([[stored], [bing_same_url], [google_same_title, google_other]])
    assert [item["source"] for item in merged] == ["event_news", "google_en"]
    assert merged[0]["title"].startswith("Nvidia beats estimates as AI")
    assert merged[1]["title"] == "Different story"


def test_합친_결과는_UTC_ISO_문자열_최신순():
    items = [_item("a", url="https://x.org/1", published="2026-11-10T00:00:00+00:00"),
             _item("b", url="https://x.org/2", published="2026-11-13T00:00:00+00:00"),
             _item("c", url="https://x.org/3", published="2026-11-11T23:59:59+00:00")]
    assert [item["title"] for item in rules.merge([items])] == ["b", "c", "a"]


# ------------------------------------------------------------------ 규칙 적용

def test_규칙_적용은_뺀_건수와_가장_최근의_오래된_날짜를_센다():
    start = rules.window_start(TODAY)
    raw = [
        _item("Recent story", url="https://x.org/1", published="2026-11-13T07:00:00+00:00"),
        _item("Old story", url="https://x.org/2", published="2023-05-01T20:00:00+00:00"),       # KST 2023-05-02
        _item("Older story", url="https://x.org/3", published="2022-01-01T00:00:00+00:00"),
        _item("No time story", url="https://x.org/4", published=None),
        _item("Future story", url="https://x.org/5", published=_iso(NOW + timedelta(days=3))),
        _item("英伟达发布新一代芯片", url="https://x.org/6", published="2026-11-13T07:00:00+00:00"),
        _item("Excluded outlet story", url="https://www.xinhuanet.com/x", domain="xinhuanet.com",
              published="2026-11-13T07:00:00+00:00"),
    ]
    kept, dropped, latest_old = rules.apply_rules(raw, start=start, now=NOW)
    assert [item["title"] for item in kept] == ["Recent story"]
    assert dropped == {"old": 2, "noTime": 2, "chinese": 1, "excluded": 1}
    assert latest_old == "2023-05-02"


def test_받은_시각_기준_줄도_같은_규칙():
    start = rules.window_start(TODAY)
    raw = [_item("Fetched", url="https://x.org/1", published="2026-11-10T00:00:00+00:00", basis="fetched")]
    kept, dropped, latest_old = rules.apply_rules(raw, start=start, now=NOW)
    assert kept[0]["timeBasis"] == "fetched" and dropped["noTime"] == 0 and latest_old is None


def test_기간별_건수():
    items = [_item(str(n), url=f"https://x.org/{n}", published=published) for n, published in enumerate([
        "2026-11-13T00:00:00+00:00",        # 1일 전
        "2026-11-06T15:00:00+00:00",        # 2026-11-07 00:00 KST — 7일 범위의 시작 그 자체
        "2026-11-06T14:59:59+00:00",        # 그 1초 전 — 30일
        "2026-09-01T00:00:00+00:00",        # 1년
        "2025-11-13T15:00:00+00:00",        # 2025-11-14 00:00 KST — 1년 범위의 시작
        "2025-03-01T00:00:00+00:00",        # 2년
    ])]
    assert rules.range_counts(items, TODAY) == {"7d": 2, "30d": 3, "1y": 5, "2y": 6}
    assert rules.range_starts(TODAY)["7d"] == "2026-11-06T15:00:00+00:00"


# ------------------------------------------------------------------ 검색식

def test_검색식은_따옴표_구문을_OR로_묶고_after를_붙인다():
    assert rules.build_query(["Ken Griffin", "Kenneth Cordele Griffin"], after="2024-11-14") == \
        '"Ken Griffin" OR "Kenneth Cordele Griffin" after:2024-11-14'
    assert rules.build_query(["삼성전자"], site="news.einfomax.co.kr", after="2024-11-14") == \
        '"삼성전자" site:news.einfomax.co.kr after:2024-11-14'
    assert rules.build_query(['Say "hi" Corp']) == '"Say hi Corp"', "구문 안의 따옴표는 지움"
    assert rules.build_query([]) is None


def test_판마다의_검색어는_이름과_긴_별칭_네_개_티커와_짧은_별칭은_빠진다():
    entity = {"kind": "company", "name": "엔비디아", "nameKo": "엔비디아", "nameEn": "Nvidia",
              "aliases": ["NVDA", "NVIDIA Corporation", "Nvidia Corp", "엔비디아 코퍼레이션", "AI칩", "nvidia",
                          "NVIDIA Graphics", "Nvidia Computing", "Nvidia Holdings Group", "英伟达"],
              "ids": {"ticker": "NVDA"}}
    assert rules.edition_terms(entity, "ko") == ["엔비디아", "엔비디아 코퍼레이션"]
    en = rules.edition_terms(entity, "en")
    assert en[0] == "Nvidia"
    assert en[1:] == ["Nvidia Holdings Group", "NVIDIA Corporation", "Nvidia Computing", "NVIDIA Graphics"]
    assert "NVDA" not in en and "英伟达" not in en


def test_짧은_이름은_이름이면_남는다():
    entity = {"kind": "company", "name": "카카오", "nameKo": "카카오", "nameEn": None, "aliases": ["카카오"],
              "ids": {"ticker": None}}
    assert rules.edition_terms(entity, "ko") == ["카카오"]
    assert rules.edition_terms(entity, "en") == []


def test_주제는_글자에_따라_한쪽_판만():
    assert rules.edition_terms({"kind": "topic", "name": "AI 반도체", "nameKo": None, "nameEn": None,
                                "aliases": ["AI 반도체"], "ids": {}}, "ko") == ["AI 반도체"]
    assert rules.edition_terms({"kind": "topic", "name": "AI 반도체", "nameKo": None, "nameEn": None,
                                "aliases": ["AI 반도체"], "ids": {}}, "en") == []
    assert rules.edition_terms({"kind": "topic", "name": "rate cut", "nameKo": None, "nameEn": None,
                                "aliases": ["rate cut"], "ids": {}}, "en") == ["rate cut"]


# ------------------------------------------------------------------ 저장본 대조

def test_별칭_대조는_영문_단어_경계_한글_포함():
    terms = ["Meta Platforms", "Meta", "메타"]
    assert rules.text_matches("Meta shares rise", terms)
    assert rules.text_matches("페이스북 모회사 메타플랫폼스", terms), "한글은 포함"
    assert not rules.text_matches("New metadata standard released", terms), "영문은 단어 경계"
    assert rules.text_matches("META, AAPL lead gains", terms), "대소문자 무시"
    assert not rules.text_matches(None, terms) and not rules.text_matches("anything", [])


def test_대조어는_이름_전부와_네_글자_이상_별칭():
    entity = {"kind": "company", "name": "카카오", "nameKo": "카카오", "nameEn": "Kakao", "aliases": ["KKO", "카카오톡 운영사"],
              "ids": {"ticker": None}}
    assert rules.match_terms(entity) == ["카카오", "Kakao", "카카오톡 운영사"]


def test_DB_대조식은_한글은_ILIKE_영문은_단어_경계_정규식():
    ilike, regex = rules.sql_patterns(["삼성_전자%", "AT&T Inc."])
    assert ilike == ["%삼성\\_전자\\%%"]
    assert regex == ["(^|[^0-9a-z])at&t inc\\.([^0-9a-z]|$)"]


# ------------------------------------------------------------------ 단계 3 — 처음 값 묶음·사용자가 더한 제외 매체

def test_처음_값은_묶음마다_도메인과_이름이고_중복이_없다():
    seed = rules.seed_list()
    assert {(row["kind"], row["value"]) for row in seed if row["kind"] == "domain"} == {("domain", d) for d in rules.EXCLUDED_DOMAINS}
    assert {row["value"] for row in seed if row["kind"] == "name"} == set(rules.EXCLUDED_NAMES)
    assert len(seed) == len({(row["kind"], row["value"]) for row in seed}), "같은 값이 두 묶음에 있으면 안 됨"
    assert {row["group"] for row in seed} == {group for group, _, _ in rules.SEED_GROUPS}
    assert all(group and (domains or names) for group, domains, names in rules.SEED_GROUPS)


@pytest.mark.parametrize("value, expected", [
    ("Example.COM", "example.com"), (" www.example.com. ", "example.com"), ("https://www.Example.com/path?q=1", "example.com"),
    ("news.example.co.uk/section", "news.example.co.uk"), ("", None), ("   ", None),
])
def test_제외_도메인_값_정규화(value, expected):
    assert rules.normalize_domain(value) == expected


def test_사용자가_더한_매체는_도메인_점_경계와_이름_완전_일치():
    extra = rules.make_excludes([
        {"kind": "domain", "value": "Example-Wire.com"}, {"kind": "name", "value": "Synthetic Daily"},
        {"kind": "name", "value": "  "}, {"kind": "other", "value": "x.com"}, {"kind": "domain", "value": None},
    ])
    assert extra == rules.Excludes(frozenset({"example-wire.com"}), frozenset({"synthetic daily"}))
    assert rules.is_excluded_media("news.example-wire.com", None, extra)
    assert rules.is_excluded_media("example-wire.com", None, extra)
    assert not rules.is_excluded_media("notexample-wire.com", None, extra), "점 경계"
    assert not rules.is_excluded_media("example-wire.com", None), "더한 목록 없이는 남음"
    assert rules.is_excluded_media(None, "SYNTHETIC DAILY on MSN", extra)
    assert not rules.is_excluded_media(None, "Synthetic Daily Weekly", extra), "이름은 완전 일치"
    assert rules.is_excluded_media("xinhuanet.com", None, extra) and rules.is_excluded_media("example.cn", None, extra)


def test_국제화_도메인은_punycode로_맞춰_대조한다():
    """화면·백엔드는 제외 도메인을 punycode(xn--)로 저장합니다(Java IDN.toASCII) — 글 주소의 유니코드 호스트도 같은 모양으로 바꿔 봅니다."""
    assert rules.ascii_host("한겨레.한국") == "xn--h89at9srwx.xn--3e0b707e"
    assert rules.ascii_host("example.com") == "example.com"
    assert rules.ascii_host("bad..한국") == "bad..한국", "바꾸지 못하면 그대로"
    assert rules.normalize_domain("한겨레.한국") == "xn--h89at9srwx.xn--3e0b707e"
    assert rules.normalize_domain("https://www.한겨레.한국/a") == "xn--h89at9srwx.xn--3e0b707e"
    extra = rules.make_excludes([{"kind": "domain", "value": "xn--h89at9srwx.xn--3e0b707e"}])
    assert rules.is_excluded_media(rules.domain_of("https://news.한겨레.한국/a"), None, extra)
    assert rules.is_excluded_media("한겨레.한국", None, extra)
    unicode_extra = rules.make_excludes([{"kind": "domain", "value": "한겨레.한국"}])
    assert rules.is_excluded_media("xn--h89at9srwx.xn--3e0b707e", None, unicode_extra)


def test_규칙_적용은_사용자가_더한_매체를_뺀_건수로_센다():
    now = datetime(2026, 11, 14, 3, tzinfo=timezone.utc)
    start = rules.window_start(rules.kst_today(now))
    items = [{"title": "Kept story", "publisherDomain": "example.org", "publisher": "Example", "publishedAt": "2026-11-13T00:00:00+00:00"},
             {"title": "Added outlet", "publisherDomain": "example-wire.com", "publisher": "Wire", "publishedAt": "2026-11-13T00:00:00+00:00"}]
    kept, dropped, _ = rules.apply_rules(items, start=start, now=now,
                                         excludes=rules.make_excludes([{"kind": "domain", "value": "example-wire.com"}]))
    assert [item["title"] for item in kept] == ["Kept story"] and dropped["excluded"] == 1
    kept, dropped, _ = rules.apply_rules(items, start=start, now=now)
    assert len(kept) == 2 and dropped["excluded"] == 0
