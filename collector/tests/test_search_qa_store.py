"""
tests/test_search_qa_store.py
정보 검색 운영 화면 점검(2026-11-15)에서 찾은 저장본 출처의 결함 — services/search_store·search_filings. DB 없이 읽는 함수를 바꿔 끼워 봅니다
(합성 행 — 실제 계좌·운영 자료 없음).

- QA-438: 수집 글·속보의 언어는 화면이 보이는 원문 제목으로 가름(번역 제목 title_ko가 아님) — 모은 글에 이미 들어간 줄도 읽을 때 같은 규칙
- QA-439: 날짜만 있는 거장 견해는 timeBasis 'date'(계약 §7-1 — 화면이 날짜만), 날짜가 없으면 저장 시각('fetched')
- QA-440: SEC 공시 제목 — 설명이 없거나 양식만 되풀이하면 흔한 양식의 짧은 한국어 뜻(모르는 양식은 양식만), 모은 글의 줄도 읽을 때 같은 규칙
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone

from app import store
from app.services import search_filings, search_store

NOW = datetime(2026, 11, 15, 5, 0, tzinfo=timezone.utc)


def _info_row(item_id, *, title, title_ko=None, source="blog.abnormalreturns", kind="article", summary=None):
    return {"id": item_id, "source": source, "kind": kind, "url": f"https://blog.example.org/{item_id}", "title": title,
            "title_ko": title_ko, "published_at": NOW, "first_seen_at": NOW, "summary": summary}


def _watch_row(item_id, *, title, source, kind="news", lang="en", publisher="Example", published_at=NOW, url=None):
    return {"item_id": item_id, "kind": kind, "title": title, "url": url or f"https://www.example.org/{item_id}",
            "publisher": publisher, "publisher_domain": "example.org", "source": source, "lang": lang, "summary": None,
            "published_at": published_at, "first_seen_at": NOW}


class _Conn:
    """store.connection() 자리 — 어떤 문장이든 정한 행을 돌려줍니다(문 시간 상한 설정 포함)."""

    def __init__(self, rows):
        self.rows = rows

    def execute(self, *_args, **_kwargs):
        return self

    def fetchall(self):
        return list(self.rows)


# ------------------------------------------------------------------ QA-438 언어

ENGLISH_POST = _info_row("i1", title="Longform links: synthetic demographic assumptions", title_ko="롱폼 링크: 합성 인구 가정",
                         summary="Links about synthetic demographics.")
KOREAN_POST = _info_row("i2", source="waedge.brief", kind="brief", title="합성전자 수급 정리")


def test_QA438_수집_글의_언어는_화면이_보이는_원문_제목으로(monkeypatch):
    monkeypatch.setattr(search_store, "_info_rows", lambda kinds, terms: [ENGLISH_POST, KOREAN_POST])
    items = {item["readerId"]: item for item in search_store.info_posts(["synthetic", "합성전자"]).items}
    assert items["i1"]["title"] == "Longform links: synthetic demographic assumptions", "화면은 원문 제목"
    assert items["i1"]["lang"] == "en", "영어 원문에 한국어 제목이 붙어 있어도 영어"
    assert items["i2"]["lang"] == "ko"


def test_QA438_첫_화면의_최근_속보도_원문_제목으로(monkeypatch):
    wire_row = _info_row("w1", source="wire.financialjuice", kind="headline", title="SYNTHETIC CENTRAL BANK HOLDS RATES",
                         title_ko="합성 중앙은행 금리 동결")

    @contextmanager
    def connection():
        yield _Conn([wire_row])

    monkeypatch.setattr(store, "connection", connection)
    items = search_store.recent_wire(5).items
    assert [(item["readerId"], item["lang"]) for item in items] == [("w1", "en")]


def test_QA438_모은_글의_수집_글·속보_줄은_읽을_때_원문_제목으로_언어를_다시_가름(monkeypatch):
    rows = [
        _watch_row("i1", title="Longform links: synthetic demographic assumptions", source="info", kind="post", lang="ko"),
        _watch_row("w1", title="SYNTHETIC CENTRAL BANK HOLDS RATES", source="wire", kind="wire", lang="ko"),
        _watch_row("i2", title="합성전자 수급 정리", source="info", kind="post", lang="en"),
        # 뉴스 출처의 lang은 받은 판(구글 한국어 판의 영어 제목 — 계약 §9-7 묶기의 설명)이라 그대로 둡니다.
        _watch_row("g1", title="Synthetic Corp opens plant", source="google_ko", lang="ko"),
    ]
    monkeypatch.setattr(search_store, "_watch_rows", lambda key, kinds: rows)
    items = {item["id"]: item for item in search_store.watch_items("topic:Synthetic", owner=True).items}
    assert {key: item["lang"] for key, item in items.items()} == {"i1": "en", "w1": "en", "i2": "ko", "g1": "ko"}


# ------------------------------------------------------------------ QA-439 거장 견해의 날짜

def test_QA439_날짜만_있는_거장_견해는_date(monkeypatch):
    payload = {"sourceUrl": "https://news.example.org/people", "gurus": [
        {"name": "합성 투자자", "stance": "중립", "score": -20, "asOf": "2026-11-15", "summary": "합성전자 관망"},
        {"name": "다른 합성 투자자", "stance": "강세", "score": 10, "asOf": None, "summary": "합성전자 비중 확대"},
    ]}
    collected = datetime(2026, 11, 15, 3, 10, tzinfo=timezone.utc)
    monkeypatch.setattr(search_store, "_guru_snapshot", lambda: (payload, collected))
    items = {item["title"].split(" 시장 견해")[0]: item for item in search_store.guru_views(["합성전자"]).items}
    dated = items["합성 투자자"]
    assert dated["publishedAt"] == "2026-11-14T15:00:00+00:00", "기준일의 KST 00:00 — 2년 자르기·정렬·기간 막대는 그 날짜"
    assert dated["timeBasis"] == "date", "출처가 날짜만 줌 — 화면은 날짜만(계약 §7-1)"
    undated = items["다른 합성 투자자"]
    assert (undated["publishedAt"], undated["timeBasis"]) == ("2026-11-15T03:10:00+00:00", "fetched"), "날짜가 없으면 저장 시각"


# ------------------------------------------------------------------ QA-440 SEC 공시 제목

CIK = "0009000001"


def _submissions(rows):
    columns = ("accessionNumber", "filingDate", "reportDate", "acceptanceDateTime", "form", "primaryDocDescription")
    recent = {column: [row.get(column, "") for row in rows] for column in columns}
    return {"cik": "9000001", "name": "SYNTHETIC FINANCIAL GROUP INC", "filings": {"recent": recent, "files": []}}


def test_QA440_SEC_회사별_공시_제목은_양식_뜻을_덧붙이고_되풀이한_설명을_뺀다():
    forms = [("4", ""), ("3", ""), ("6-K", "FORM 6-K"), ("4/A", "FORM 4"), ("SC 13G/A", "SC 13G/A"), ("8-K", "8-K"),
             ("10-Q", "Quarterly report"), ("N-PX", ""), ("20-F", "Form 20-F"), ("F-3ASR", "FORM F-3 ASR")]
    rows = [{"accessionNumber": f"0009000001-26-{n:06d}", "filingDate": "2026-11-10", "form": form, "primaryDocDescription": described}
            for n, (form, described) in enumerate(forms)]
    items, _ = search_filings.parse_submissions(_submissions(rows), cik=CIK, start_day="2024-11-15")
    assert [item["title"] for item in items] == [
        "4 · 지분 변동 보고",
        "3 · 최초 지분 보고",
        "6-K · 외국 기업 수시 보고",
        "4/A · 지분 변동 보고 수정",                # '/A'(amendment)는 '수정' — 13G/A 같은 보유 변동 갱신을 오류 정정으로 읽지 않게(검토 지적)
        "SC 13G/A · 5% 초과 지분 보고(약식) 수정",  # 13D·13G는 5% 초과(more than five percent) 보유자의 보고
        "8-K · 수시 보고(주요 사건)",
        "10-Q · Quarterly report",        # 쓸 만한 설명은 그대로(뜻을 덧붙이지 않음)
        "N-PX",                           # 모르는 양식은 양식만
        "20-F · 외국 기업 연차 보고서",
        "F-3ASR",                         # 설명이 양식 사이에 빈칸을 끼워 되풀이해도 되풀이(검토 지적)
    ]


def test_QA440_전문_검색_제목은_양식_뜻과_제출자():
    def hit(adsh, form, name):
        return {"_id": f"{adsh}:doc.xml", "_source": {"adsh": adsh, "ciks": ["0009000077"], "display_names": [name],
                                                       "file_date": "2026-11-02", "form": form, "root_forms": [form]}}

    payload = {"hits": {"total": {"value": 3, "relation": "eq"}, "hits": [
        hit("0009000077-26-000001", "4", "Synthetic Owner Jane  (CIK 0009000077)"),
        hit("0009000077-26-000002", "N-PX", "Synthetic Fund Trust  (CIK 0009000077)"),
        hit("0009000077-26-000003", "10-K", ""),
    ]}}
    items, _, _ = search_filings.parse_fts(payload)
    assert [item["title"] for item in items] == ["4 · 지분 변동 보고 · Synthetic Owner Jane", "N-PX · Synthetic Fund Trust",
                                                 "10-K · 연차 보고서"]


def test_QA440_모은_글의_SEC_줄은_읽을_때_지금_규칙으로_제목을_다시_만든다(monkeypatch):
    sec_url = "https://www.sec.gov/Archives/edgar/data/9000001/000900000126000001/0009000001-26-000001-index.htm"
    rows = [
        _watch_row("f1", title="4", source="sec", kind="filing", publisher="SYNTHETIC FINANCIAL GROUP INC", url=sec_url),
        _watch_row("f2", title="6-K · FORM 6-K", source="sec", kind="filing", url=sec_url + "?2"),
        _watch_row("f3", title="10-Q · Quarterly report", source="sec", kind="filing", url=sec_url + "?3"),
        _watch_row("f4", title="4 · 지분 변동 보고", source="sec", kind="filing", url=sec_url + "?4"),
        _watch_row("f5", title="4 · Synthetic Owner Jane", source="sec_fts", kind="filing", publisher="Synthetic Owner Jane",
                   url=sec_url + "?5"),
        _watch_row("f6", title="4 · 지분 변동 보고 · Synthetic Owner Jane", source="sec_fts", kind="filing",
                   publisher="Synthetic Owner Jane", url=sec_url + "?6"),
        _watch_row("f7", title="분기보고서", source="dart", kind="filing", lang="ko", url="https://dart.fss.or.kr/dsaf001/main.do?rcpNo=1"),
        _watch_row("f8", title="F-3ASR · FORM F-3 ASR", source="sec", kind="filing", url=sec_url + "?8"),
        _watch_row("n1", title="4", source="bing"),
    ]
    monkeypatch.setattr(search_store, "_watch_rows", lambda key, kinds: rows)
    titles = {item["id"]: item["title"] for item in search_store.watch_items("us:SYNF", owner=True).items}
    assert titles == {
        "f1": "4 · 지분 변동 보고",
        "f2": "6-K · 외국 기업 수시 보고",
        "f3": "10-Q · Quarterly report",
        "f4": "4 · 지분 변동 보고",                              # 이미 지금 규칙으로 넣은 줄은 그대로
        "f5": "4 · 지분 변동 보고 · Synthetic Owner Jane",
        "f6": "4 · 지분 변동 보고 · Synthetic Owner Jane",
        "f7": "분기보고서",                                       # DART·뉴스 줄은 그대로
        "f8": "F-3ASR",
        "n1": "4",
    }
