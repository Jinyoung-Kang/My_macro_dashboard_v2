"""
tests/test_search_filings.py
정보 검색 공시 탭의 출처(services/search_filings — 계약 §7-1·§7-2, ADR 0041 단계 4) — 네트워크 없이 합성 응답으로.

- 날짜만 아는 줄(timeBasis "date"): 그 출처 달력(DART KST·SEC 미국 동부)의 00:00을 UTC ISO로
- SEC submissions: 제목(양식 · 설명), 접수 색인 쪽 주소, id = item_id("sec:" + 접수번호), 접수 시각(미국 동부 벽시계)·없으면 접수일(date),
  최근 블록의 가장 오래된 접수일이 창 안이고 그 앞 파일이 있으면 안내, SEC 세션·토큰 버킷
- EDGAR 전문 검색: 제출자 이름 다듬기, 같은 접수는 한 줄, 첫 구문이 0건이면 다음 구문 한 번(앞에 before_retry), 첫 쪽만
- DART list.json: 제목·주소·제출인·접수일(KST)·비고, 2쪽까지, 013은 빈 결과, 인증키는 사유·로그 어디에도 남지 않음
- 실패 사유는 호스트와 상태만, 로그(urllib3 재시도 경고)에 검색어·경로가 남지 않음
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timezone

import pytest

from app import http, publicapi, settings
from app.services import info_text
from app.services import search_filings as filings
from app.services import search_rules as rules

SECRET = "Synthetic Secret Holdings"
DART_KEY = "f" * 40
CIK = "0009000001"


class Response:
    def __init__(self, status=200, payload=None, *, bad_json=False):
        self.status_code = status
        self._payload = payload
        self._bad_json = bad_json
        self.headers = {"Content-Type": "application/json"}

    def json(self):
        if self._bad_json:
            raise ValueError("not json")
        return self._payload


class Session:
    """SEC 세션 자리 — 요청을 적고 정한 응답을 차례로 돌려줍니다."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls: list[dict] = []

    def get(self, url, params=None, timeout=None, headers=None):
        self.calls.append({"url": url, "params": dict(params or {}), "timeout": timeout})
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def _submissions(rows, *, files=None, name="SYNTHCHIP CORP"):
    columns = ("accessionNumber", "filingDate", "reportDate", "acceptanceDateTime", "form", "primaryDocDescription")
    recent = {column: [row.get(column, "") for row in rows] for column in columns}
    return {"cik": "9000001", "name": name, "filings": {"recent": recent, "files": files or []}}


# ------------------------------------------------------------------ 시각(§7-1)

def test_날짜만_아는_줄은_그_출처_달력의_00시를_UTC로():
    assert rules.utc_iso(filings.date_moment("2026-11-13", filings.KST)) == "2026-11-12T15:00:00+00:00"
    assert rules.utc_iso(filings.date_moment("20261113", filings.KST)) == "2026-11-12T15:00:00+00:00"
    # 미국 동부 — 겨울(EST, UTC-5)과 여름(EDT, UTC-4)
    assert rules.utc_iso(filings.date_moment("2026-01-15", filings.NEW_YORK)) == "2026-01-15T05:00:00+00:00"
    assert rules.utc_iso(filings.date_moment("2026-07-15", filings.NEW_YORK)) == "2026-07-15T04:00:00+00:00"
    for bad in (None, "", "2026-13-01", "abc", "2026111", 20261113):
        assert filings.date_moment(bad, filings.KST) is None


def test_모은_글의_공시_줄은_날짜만_아는_출처면_date로_되살린다():
    midnight_ny = datetime(2026, 11, 13, 5, 0, tzinfo=timezone.utc)          # 2026-11-13 00:00 EST
    accepted = datetime(2026, 11, 13, 21, 5, tzinfo=timezone.utc)            # 16:05 EST
    assert filings.stored_basis("sec", midnight_ny) == "date"
    assert filings.stored_basis("sec", accepted) == "published"
    assert filings.stored_basis("sec_fts", accepted) == "date"
    assert filings.stored_basis("dart", datetime(2026, 11, 12, 15, 0, tzinfo=timezone.utc)) == "date"
    assert filings.stored_basis("bing", midnight_ny) == "published"


# ------------------------------------------------------------------ SEC submissions

def test_SEC_회사별_공시_줄():
    payload = _submissions([
        {"accessionNumber": "0009000001-26-000101", "filingDate": "2026-11-13", "reportDate": "2026-10-26",
         "acceptanceDateTime": "2026-11-12T18:08:27.000Z", "form": "10-Q", "primaryDocDescription": "Quarterly report"},
        {"accessionNumber": "0009000001-26-000100", "filingDate": "2026-11-10", "reportDate": "",
         "acceptanceDateTime": "", "form": "8-K", "primaryDocDescription": "8-K"},
        {"accessionNumber": "bad-accession", "filingDate": "2026-11-09", "form": "4"},
    ])
    items, note = filings.parse_submissions(payload, cik=CIK, start_day="2024-11-14")
    assert note is None, "그 앞 파일이 없으면 안내 없음"
    assert len(items) == 2, "접수번호 모양이 틀린 줄은 뺌"
    first, second = items
    assert first["title"] == "10-Q · Quarterly report" and first["kind"] == "filing" and first["source"] == "sec"
    assert first["url"] == "https://www.sec.gov/Archives/edgar/data/9000001/000900000126000101/0009000001-26-000101-index.htm"
    assert first["id"] == info_text.item_id("sec:0009000001-26-000101")
    assert first["publisher"] == "SYNTHCHIP CORP" and first["publisherDomain"] == "sec.gov" and first["lang"] == "en"
    # 접수 시각은 꼬리의 Z 그대로 UTC — 서버 실측(2026-11-14): submissions '…T13:52:41.000Z' = 색인 쪽 'Accepted 08:52:41'(EST).
    assert first["publishedAt"] == "2026-11-12T18:08:27+00:00" and first["timeBasis"] == "published"
    assert first["summary"] == "보고 기준일 2026-10-26" and first["readerId"] is None
    assert second["title"] == "8-K", "설명이 양식과 같으면 양식만"
    assert second["publishedAt"] == "2026-11-10T05:00:00+00:00" and second["timeBasis"] == "date"
    assert second["summary"] is None


def test_SEC_최근_블록의_가장_오래된_접수일이_창_안이고_그_앞_파일이_있으면_안내():
    rows = [{"accessionNumber": f"0009000001-26-{n:06d}", "filingDate": "2025-06-01", "form": "4"} for n in range(3)]
    files = [{"name": "CIK0009000001-submissions-001.json"}]
    _, note = filings.parse_submissions(_submissions(rows, files=files), cik=CIK, start_day="2024-11-14")
    assert note == "최근 1,000건만 — 그 앞은 SEC에서"
    old = rows + [{"accessionNumber": "0009000001-20-000001", "filingDate": "2020-01-02", "form": "4"}]
    items, note = filings.parse_submissions(_submissions(old, files=files), cik=CIK, start_day="2024-11-14")
    assert note is None, "가장 오래된 줄이 창 밖이면 그 앞 파일은 필요 없음"
    assert len(items) == 4, "2년 밖 줄도 넘김 — 2년 자르기·olderOnlyLatest는 규칙(search_rules)이 함"


def test_SEC_회사별_공시는_SEC_세션과_토큰_버킷으로_한_번(monkeypatch):
    session = Session(Response(200, _submissions([{"accessionNumber": "0009000001-26-000101", "filingDate": "2026-11-13",
                                                     "form": "10-Q"}])))
    limited = []
    monkeypatch.setattr(http, "get_sec_session", lambda: session)
    monkeypatch.setattr(http, "sec_rate_limit", lambda: limited.append(1))
    out = filings.sec_submissions(CIK, start_day="2024-11-14")
    assert out.error is None and len(out.items) == 1
    assert [call["url"] for call in session.calls] == ["https://data.sec.gov/submissions/CIK0009000001.json"]
    assert limited == [1]


@pytest.mark.parametrize("response,expected", [
    (Response(503), "data.sec.gov HTTP 503"),
    (Response(200, bad_json=True), "data.sec.gov 응답이 JSON이 아님"),
    (Response(200, ["not", "a", "dict"]), "data.sec.gov 응답 모양이 다름"),
])
def test_SEC_실패는_호스트와_상태만(monkeypatch, response, expected):
    monkeypatch.setattr(http, "sec_rate_limit", lambda: None)
    out = filings.sec_submissions(CIK, start_day="2024-11-14", session=Session(response))
    assert out.error == expected and out.items == []


def test_SEC_404는_빈_결과와_안내(monkeypatch):
    monkeypatch.setattr(http, "sec_rate_limit", lambda: None)
    out = filings.sec_submissions(CIK, start_day="2024-11-14", session=Session(Response(404)))
    assert out.error is None and out.items == [] and "없음" in out.note


def test_SEC_사용자_에이전트가_없으면_부르지_않는다(monkeypatch):
    def missing():
        raise http.SecUserAgentMissing()

    monkeypatch.setattr(http, "get_sec_session", missing)
    out = filings.sec_submissions(CIK, start_day="2024-11-14")
    assert out.error and "SEC_USER_AGENT" in out.error


def test_SEC_거부는_래치_한_줄_그대로(monkeypatch):
    monkeypatch.setattr(http, "sec_rate_limit", lambda: None)
    rejected = http.SourceRejected("data.sec.gov", "HTTP 403")
    out = filings.sec_submissions(CIK, start_day="2024-11-14", session=Session(rejected))
    assert out.error.startswith(http.REJECTED_MARK) and "data.sec.gov" in out.error


# ------------------------------------------------------------------ EDGAR 전문 검색

def _fts(hits, *, total=None, relation="eq"):
    return {"hits": {"total": {"value": len(hits) if total is None else total, "relation": relation},
                     "hits": [{"_id": f"{hit['adsh']}:doc{n}.htm", "_source": hit} for n, hit in enumerate(hits)]}}


FTS_HIT = {"adsh": "0009000077-26-000005", "ciks": ["0009000077"],
           "display_names": ["Synthetic Family Office LLC  (CIK 0009000077)"], "file_date": "2026-08-14", "form": "13F-HR",
           "root_forms": ["13F-HR"], "file_description": "Quarterly holdings report"}


def test_전문_검색_줄은_제출자_이름을_다듬고_같은_접수는_한_줄():
    hits = [FTS_HIT, dict(FTS_HIT, file_description="Information table"),
            {"adsh": "0009000088-26-000001", "ciks": ["0009000088", "0009000077"],
             "display_names": ["SYNTH CORP  (SYNC, SYNC-W)  (CIK 0009000088)"], "file_date": "2026-03-02", "form": "",
             "root_forms": ["S-1"], "file_description": ""},
            {"adsh": "0009000099-26-000001", "ciks": [], "display_names": ["No Cik Filer"], "file_date": "2026-03-01",
             "form": "8-K"}]
    items, total, at_least = filings.parse_fts(_fts(hits))
    assert (total, at_least) == (4, False)
    assert [item["title"] for item in items] == ["13F-HR · Synthetic Family Office LLC", "S-1 · SYNTH CORP"], \
        "같은 접수(문서 둘)는 한 줄, CIK가 없는 줄은 연결할 쪽이 없어 뺌"
    first = items[0]
    assert first["id"] == info_text.item_id("sec:0009000077-26-000005"), "SEC 회사별 목록과 같은 id(접수번호)"
    assert first["url"] == "https://www.sec.gov/Archives/edgar/data/9000077/000900007726000005/0009000077-26-000005-index.htm"
    assert first["publisher"] == "Synthetic Family Office LLC" and first["publisherDomain"] == "sec.gov"
    assert first["publishedAt"] == "2026-08-14T04:00:00+00:00" and first["timeBasis"] == "date"
    assert first["summary"] == "Quarterly holdings report" and first["source"] == "sec_fts" and first["kind"] == "filing"
    assert items[1]["summary"] is None


def test_전문_검색은_첫_구문이_0건이면_다음_구문을_한_번_더(monkeypatch):
    monkeypatch.setattr(http, "sec_rate_limit", lambda: None)
    session = Session(Response(200, _fts([])), Response(200, _fts([FTS_HIT], total=250, relation="gte")))
    asked = []
    out = filings.sec_fts(['"Synthetic Family Office"', '"Synth Family"', '"Third"'], start_day="2024-11-14",
                          end_day="2026-11-14", before_retry=lambda: asked.append(1) or True, session=session)
    assert asked == [1] and len(session.calls) == 2
    assert session.calls[0]["url"] == "https://efts.sec.gov/LATEST/search-index"
    assert session.calls[0]["params"] == {"q": '"Synthetic Family Office"', "dateRange": "custom", "startdt": "2024-11-14",
                                          "enddt": "2026-11-14"}
    assert session.calls[1]["params"]["q"] == '"Synth Family"'
    assert len(out.items) == 1 and out.note == "첫 쪽만 받음(전체 250건 이상 — 나머지는 SEC에서)"


def test_전문_검색은_before_retry가_거짓이면_두_번째_구문을_묻지_않고_max_phrases를_지킨다(monkeypatch):
    monkeypatch.setattr(http, "sec_rate_limit", lambda: None)
    session = Session(Response(200, _fts([])))
    out = filings.sec_fts(['"A B"', '"C D"'], start_day="2024-11-14", end_day="2026-11-14", before_retry=lambda: False,
                          session=session)
    assert len(session.calls) == 1 and out.items == [] and out.error is None
    session = Session(Response(200, _fts([])))
    filings.sec_fts(['"A B"', '"C D"'], start_day="2024-11-14", end_day="2026-11-14", max_phrases=1, session=session)
    assert len(session.calls) == 1
    assert filings.sec_fts([], start_day="2024-11-14", end_day="2026-11-14", session=Session()).items == []


def test_전문_검색_실패는_호스트와_상태만이고_첫_구문이_0건인데_다음_구문이_실패해도_실패(monkeypatch):
    monkeypatch.setattr(http, "sec_rate_limit", lambda: None)
    out = filings.sec_fts([f'"{SECRET}"'], start_day="2024-11-14", end_day="2026-11-14", session=Session(Response(500)))
    assert out.error == "efts.sec.gov HTTP 500"
    out = filings.sec_fts(['"A B"', '"C D"'], start_day="2024-11-14", end_day="2026-11-14",
                          session=Session(Response(200, _fts([])), Response(503)))
    # 받은 줄이 없고 이름을 다 묻지 못함 — '빈 결과'(15분 캐시)가 아니라 실패(60초 캐시, 상태 error). Bing과 같음.
    assert out.error == "efts.sec.gov HTTP 503" and out.items == []


def test_로그에_검색어와_경로가_남지_않는다(caplog):
    record = logging.LogRecord("urllib3.connectionpool", logging.WARNING, __file__, 1,
                               "Retrying (%r) after connection broken by '%r': %s",
                               ("Retry(total=1)", "ReadTimeoutError()",
                                f"/LATEST/search-index?q=%22{SECRET.replace(' ', '+')}%22&dateRange=custom"), None)
    with caplog.at_level(logging.WARNING, logger="urllib3.connectionpool"):
        logging.getLogger("urllib3.connectionpool").handle(record)
    assert SECRET.replace(" ", "+") not in caplog.text and "search-index" not in caplog.text
    for path in ("/api/list.json?corp_code=00900001&bgn_de=20241114", "/api/v1/lei-records/SYNTH0000000000000001/direct-parent",
                 "/submissions/CIK0009000001.json"):
        assert filings._scrub(path) == "(검색 경로 생략)", path


# ------------------------------------------------------------------ DART list.json

def _dart(rows, *, total_count=None, total_page=1, page_no=1, status="000"):
    return {"status": status, "message": "정상", "page_no": page_no, "page_count": 100,
            "total_count": len(rows) if total_count is None else total_count, "total_page": total_page,
            "list": rows}


DART_ROW = {"corp_code": "00900001", "corp_name": "합성전자", "stock_code": "900001", "corp_cls": "Y",
            "report_nm": "  주요사항보고서(자기주식취득결정)  ", "rcept_no": "20261113000123", "flr_nm": "합성전자",
            "rcept_dt": "20261113", "rm": "유"}


class DartCalls(list):
    """publicapi.get 자리의 기록(부른 인자) — ``replies``에 넣은 응답을 차례로 돌려줍니다."""

    def __init__(self):
        super().__init__()
        self.replies: list = []


@pytest.fixture()
def dart_calls(monkeypatch):
    calls = DartCalls()
    monkeypatch.setattr(settings, "dart_key", lambda: DART_KEY)

    def fake_get(base, params, *, key, key_param="serviceKey", timeout=20.0):
        calls.append({"base": base, "params": dict(params), "key": key, "key_param": key_param})
        reply = calls.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply

    monkeypatch.setattr(publicapi, "get", fake_get)
    return calls


def test_DART_공시_줄():
    items, total, pages = filings.parse_dart(_dart([DART_ROW, dict(DART_ROW, rcept_no="20261112000999", rm="",
                                                                    report_nm="분기보고서 (2026.09)", rcept_dt="20261112")]))
    assert (total, pages) == (2, 1)
    first = items[0]
    assert first["title"] == "주요사항보고서(자기주식취득결정)" and first["kind"] == "filing" and first["source"] == "dart"
    assert first["url"] == "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261113000123"
    assert first["id"] == info_text.item_id(first["url"])
    assert first["publisher"] == "합성전자" and first["publisherDomain"] == "dart.fss.or.kr" and first["lang"] == "ko"
    assert first["publishedAt"] == "2026-11-12T15:00:00+00:00" and first["timeBasis"] == "date"
    assert first["summary"] == "비고 유"
    assert items[1]["summary"] is None


def test_DART는_첫_쪽_뒤_2쪽까지_받고_전체_건수를_안내(dart_calls):
    dart_calls.replies += [Response(200, _dart([DART_ROW], total_count=3722, total_page=38)),
                           Response(200, _dart([dict(DART_ROW, rcept_no="20261101000001")], total_count=3722, total_page=38,
                                               page_no=2))]
    out = filings.dart_list("00900001", start_day="2024-11-14", end_day="2026-11-14")
    assert len(out.items) == 2 and out.error is None
    assert out.note == "최근 2건(전체 3,722건 — 그 앞은 DART에서)"
    first = dart_calls[0]
    assert first["base"] == "https://opendart.fss.or.kr/api/list.json" and first["key_param"] == "crtfc_key"
    assert first["params"] == {"corp_code": "00900001", "bgn_de": "20241114", "end_de": "20261114", "sort": "date",
                               "sort_mth": "desc", "page_count": "100", "page_no": "1"}
    assert dart_calls[1]["params"]["page_no"] == "2" and len(dart_calls) == 2


def test_DART_첫_쪽만_묻기와_한_쪽뿐인_결과(dart_calls):
    dart_calls.replies += [Response(200, _dart([DART_ROW], total_count=150, total_page=2))]
    out = filings.dart_list("00900001", start_day="2024-11-14", end_day="2026-11-14", max_pages=1)
    assert len(dart_calls) == 1 and len(out.items) == 1 and "전체 150건" in out.note
    dart_calls.replies += [Response(200, _dart([DART_ROW]))]
    out = filings.dart_list("00900001", start_day="2024-11-14", end_day="2026-11-14")
    assert len(dart_calls) == 2 and out.note is None


def test_DART_자료_없음은_빈_결과_그_밖의_상태는_실패(dart_calls):
    dart_calls.replies += [Response(200, {"status": "013", "message": "조회된 데이타가 없습니다."})]
    out = filings.dart_list("00900001", start_day="2024-11-14", end_day="2026-11-14")
    assert out.error is None and out.items == []
    dart_calls.replies += [Response(200, {"status": "020", "message": f"요청 제한을 초과하였습니다. key={DART_KEY}"})]
    out = filings.dart_list("00900001", start_day="2024-11-14", end_day="2026-11-14")
    assert out.error.startswith("opendart.fss.or.kr status 020") and DART_KEY not in out.error


def test_DART_2쪽이_실패하면_첫_쪽과_안내(dart_calls):
    dart_calls.replies += [Response(200, _dart([DART_ROW], total_count=300, total_page=3)), Response(502)]
    out = filings.dart_list("00900001", start_day="2024-11-14", end_day="2026-11-14")
    assert len(out.items) == 1 and out.error is None and "2쪽을 받지 못함(opendart.fss.or.kr HTTP 502)" in out.note


def test_보내기_전에_설정을_미리_본다_사유에_설정값이_없다(monkeypatch):
    monkeypatch.setattr(settings, "dart_key", lambda: "  ")
    assert "DART_API_KEY" in filings.dart_unready()
    monkeypatch.setattr(settings, "dart_key", lambda: DART_KEY)
    assert filings.dart_unready() is None

    def invalid():
        raise http.SecUserAgentInvalid(f"SEC_USER_AGENT에 이메일 주소가 없습니다: '{SECRET}'")

    monkeypatch.setattr(http, "sec_user_agent", invalid)
    reason = filings.sec_unready()
    assert "SEC_USER_AGENT" in reason and SECRET not in reason
    monkeypatch.setattr(http, "sec_user_agent", lambda: "Synthetic Tool (contact: owner@example.org)")
    assert filings.sec_unready() is None


def test_DART_연결_실패와_키_없음은_사유에_주소·키가_없다(dart_calls, monkeypatch):
    dart_calls.replies += [publicapi.PublicApiError(f"ConnectionError: /api/list.json?crtfc_key={DART_KEY}&corp_code=00900001")]
    out = filings.dart_list("00900001", start_day="2024-11-14", end_day="2026-11-14")
    assert out.error == "opendart.fss.or.kr 연결·응답 실패"
    monkeypatch.setattr(settings, "dart_key", lambda: "")
    out = filings.dart_list("00900001", start_day="2024-11-14", end_day="2026-11-14")
    assert out.error and "DART_API_KEY" in out.error and len(dart_calls) == 1


def test_윤년_창과_날짜_인자():
    assert filings.compact_day("2024-02-29") == "20240229"
    assert filings.compact_day(date(2026, 1, 2)) == "20260102"
