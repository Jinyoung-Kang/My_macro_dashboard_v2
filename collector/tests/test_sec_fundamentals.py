"""
tests/test_sec_fundamentals.py
모의 매매 미국 종목 재무(SEC XBRL Company Facts, 명세 D28·설계 §4-5) — 추출·중복 제거·공시일 묶기·순서·예산·실패 규칙.

고정하는 규칙
  1. 추출: 후보 개념(us-gaap·ifrs-full·dei)만, 서식 10-Q·10-K·20-F·40-F와 /A만, 연간(350~380일)은 end ≥ 2020-01-01,
     나머지는 end ≥ 2023-07-01. 값이 없거나 숫자가 아닌 사실은 버린다(0으로 채우지 않음). 단위(통화)는 그대로.
  2. 중복: 같은 (t, c, u, s, e)는 처음 낸 값 + 그 뒤 값이 바뀐 행만. 같은 날 값이 둘이면 정정(/A) 우선, 그다음 접수 번호 순의
     마지막 하나만.
  3. 저장: obs_date = 공시일, payload = {"cik": [...], "facts": [{t,c,u,s,e,v,f,a,fy,fp}]}, 같은 날 공시는 한 행.
     같은 내용이면 다시 쓰지 않는다(updated_at 그대로). 지우지 않는다 — 다만 받은 회사의 지금 CIK 목록에 없는 CIK만으로 쌓인
     행은 지운다(티커 재배정). ETF(PAPER_ETFS·13F 매핑표의 ETP)는 대상이 아니다.
  4. 별칭표의 CIK 여러 개는 합친다 — 새 CIK의 비교 열(옛 CIK와 같은 값)은 버려진다.
  5. 순서: ① 받은 적 없음 ② 새 공시 마감이 지났는데 그 뒤로 안 받음 ③ 오래전에 받은 순, 같은 순위는 티커 순.
  6. 예산(FUNDAMENTALS_FETCH_BUDGET)은 companyfacts 요청 수. 같은 CIK를 쓰는 티커는 한 번만 받는다. 별칭 회사는 예산이
     모자라면 통째로 다음 실행.
  7. 일부 실패 → 그 회사의 상태 줄은 이전 값 이어받기 + isStale, 관측 행은 그대로. 전부 실패 → EmptyResult(상태 그대로).
     404는 'no companyfacts'(답), 전에 자료가 있던 회사의 404는 일시 장애로 보고 이어받는다. 연속 실패 상한은 직전에 이미
     실패한 회사를 세지 않고, 한 곳도 못 받은 채 걸리면 정상 회사 하나로 확인한 뒤에만 멈춘다(계속 실패하는 회사가 태스크를 멈추지 않게).
  8. SEC_USER_AGENT 값(소유자 이메일)은 실패 문구에 싣지 않는다.

외부 네트워크를 쓰지 않습니다 — 가짜 SEC 세션이 tests/fixtures/sec/의 문서(실제 모양·측정값으로 만든 작은 문서)를 돌려줍니다.
태스크 테스트는 PostgreSQL이 필요합니다(store 픽스처, macrodash_test). 순수 함수 테스트는 DB 없이 돕니다.
"""
from __future__ import annotations

import copy
import json
import re
from datetime import date
from pathlib import Path

import pytest

from app import catalog, indicators, paper_universe, settings, tasks
from app.services import sec_fundamentals as sf
from app.tasks import fundamentals as task_module
from app.tasks.base import EmptyResult

FIXTURES = Path(__file__).parent / "fixtures" / "sec"

AAPL, GOOG, GPRO, IBN, SAP = "0000320193", "0001652044", "0001500435", "0001103838", "0001000184"
XOM_NEW, XOM_OLD = "0002115436", "0000034088"
TODAY = date(2026, 10, 25)


def _doc(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _fact(c="NetIncomeLoss", *, t="us-gaap", u="USD", s="2026-04-01", e="2026-06-30", v=100, f="10-Q",
          a="0000000001-26-000001", filed="2026-08-01", cik="0000000001", fy=2026, fp="Q2") -> dict:
    return {"t": t, "c": c, "u": u, "s": s, "e": e, "v": v, "f": f, "a": a, "fy": fy, "fp": fp, "filed": filed, "cik": cik}


def _wrap(concept: str, unit: str, rows: list[dict], taxonomy: str = "us-gaap") -> dict:
    return {"facts": {taxonomy: {concept: {"label": concept, "units": {unit: rows}}}}}


# ==============================================================================
# 1. 추출 (네트워크·DB 없음)
# ==============================================================================
def test_추출은_후보_개념_서식_기간_창만_남기고_단위를_그대로_둔다():
    facts = sf.extract_facts(_doc("companyfacts_aapl.json"), AAPL)

    concepts = {f["c"] for f in facts}
    assert "EarningsPerShareBasic" not in concepts, "후보 밖 개념은 받지 않습니다"
    assert {f["f"] for f in facts} <= {"10-Q", "10-K"}, "8-K 사실은 버립니다"
    ends = {(f["c"], f["s"], f["e"]) for f in facts}
    # 2023-07-01 전에 끝난 분기·2020-01-01 전에 끝난 연간은 창 밖, 2020년 이후 연간은 남김
    assert ("RevenueFromContractWithCustomerExcludingAssessedTax", "2023-01-01", "2023-04-01") not in ends
    assert ("RevenueFromContractWithCustomerExcludingAssessedTax", "2018-09-30", "2019-09-28") not in ends
    assert ("RevenueFromContractWithCustomerExcludingAssessedTax", "2019-09-29", "2020-09-26") in ends
    shares = next(f for f in facts if f["t"] == "dei")
    assert shares == {"t": "dei", "c": "EntityCommonStockSharesOutstanding", "u": "shares", "s": None, "e": "2026-07-17",
                      "v": 14594180000, "f": "10-Q", "a": "0000320193-26-000020", "fy": 2026, "fp": "Q3",
                      "filed": "2026-07-31", "cik": AAPL}
    assert {f["u"] for f in facts} == {"USD", "shares"}


def test_IFRS_EUR_회사는_통화를_바꾸지_않고_6K는_버린다():
    facts = sf.extract_facts(_doc("companyfacts_sap.json"), SAP)
    assert {(f["t"], f["u"]) for f in facts} == {("ifrs-full", "EUR"), ("dei", "shares")}
    assert all(f["f"] == "20-F" for f in facts)
    assert "CashFlowsFromUsedInOperatingActivities" not in {f["c"] for f in facts}


def test_값이_없거나_숫자가_아니거나_날짜가_틀린_사실은_버린다():
    rows = [
        {"start": "2026-04-01", "end": "2026-06-30", "val": None, "form": "10-Q", "filed": "2026-08-01"},
        {"start": "2026-04-01", "end": "2026-06-30", "val": "12", "form": "10-Q", "filed": "2026-08-01"},
        {"start": "2026-04-01", "end": "2026-06-30", "val": True, "form": "10-Q", "filed": "2026-08-01"},
        {"start": "2026-04-01", "end": "2026-06-31", "val": 5, "form": "10-Q", "filed": "2026-08-01"},
        {"start": "2026-04-01", "end": "2026-06-30", "val": 5, "form": "10-Q"},
        {"start": "2026-04-01", "end": "2026-06-30", "val": 0, "form": "10-Q/A", "filed": "2026-08-02"},
    ]
    facts = sf.extract_facts(_wrap("NetIncomeLoss", "USD", rows))
    assert [(f["v"], f["f"]) for f in facts] == [(0, "10-Q/A")], "진짜 0은 남기고, 없는 값은 만들지 않습니다"


def test_연간_판정은_350에서_380일_52주53주_포함():
    assert sf.is_annual("2024-09-29", "2025-09-27")      # 363일(52주)
    assert sf.is_annual("2023-10-01", "2024-09-28")      # 364일
    assert not sf.is_annual("2025-09-28", "2026-06-27")  # 9개월 누계
    assert not sf.is_annual(None, "2026-06-27")          # 시점 사실


# ==============================================================================
# 2. 중복 제거·공시일 묶기
# ==============================================================================
def test_비교_열의_같은_값은_버리고_처음_낸_값만_남긴다():
    facts = sf.dedup_facts(sf.extract_facts(_doc("companyfacts_aapl.json"), AAPL))

    ocf = [(f["s"], f["e"], f["filed"]) for f in facts if f["c"] == "NetCashProvidedByUsedInOperatingActivities"]
    # 10-Q 현금흐름은 누계 — 1분기·6개월·9개월·연간·당해 9개월, 다음 해 비교 열(2026 공시)은 같은 값이라 버림
    assert ocf == [("2024-09-29", "2024-12-28", "2025-01-31"), ("2024-09-29", "2025-03-29", "2025-05-02"),
                   ("2024-09-29", "2025-06-28", "2025-08-01"), ("2024-09-29", "2025-09-27", "2025-10-31"),
                   ("2025-09-28", "2026-06-27", "2026-07-31")]
    revenue_q = [f for f in facts if f["c"].startswith("Revenue") and f["s"] == "2025-03-30"]
    assert [(f["filed"], f["a"]) for f in revenue_q] == [("2025-08-01", "0000320193-25-000073")], \
        "frame이 붙은 쪽(2026 비교 열)이 아니라 처음 낸 값"


def test_정정_공시가_값을_바꾸면_두_값을_모두_남기고_같은_값의_재게재는_버린다():
    facts = sf.dedup_facts(sf.extract_facts(_doc("companyfacts_gpro.json"), GPRO))
    nine_months = [(f["v"], f["f"], f["filed"]) for f in facts if f["s"] == "2025-01-01" and f["e"] == "2025-09-30"]
    assert nine_months == [(-84383000, "10-Q", "2025-11-06"), (-90549000, "10-K/A", "2026-10-19")]
    annual = [(f["f"], f["filed"]) for f in facts if f["e"] == "2025-12-31"]
    assert annual == [("10-K", "2026-02-27")]


def test_값이_돌아오면_다시_남기고_같은_날_두_값이면_그날_마지막_접수만():
    a_then_b_then_a = [_fact(v=1, filed="2026-01-10"), _fact(v=2, filed="2026-02-10"), _fact(v=1, filed="2026-03-10")]
    assert [f["v"] for f in sf.dedup_facts(a_then_b_then_a)] == [1, 2, 1]

    same_day = [_fact(v=1, filed="2026-01-10"),
                _fact(v=2, filed="2026-02-10", a="0000000001-26-000005", f="10-Q"),
                _fact(v=3, filed="2026-02-10", a="0000000001-26-000009", f="10-Q/A")]
    assert [(f["v"], f["filed"]) for f in sf.dedup_facts(same_day)] == [(1, "2026-01-10"), (3, "2026-02-10")]

    # 같은 날 정정이 원래 값으로 되돌리면 그날은 '바뀌지 않음' — 그날 행에서 빠집니다
    back = [_fact(v=1, filed="2026-01-10"),
            _fact(v=2, filed="2026-02-10", a="0000000001-26-000005"),
            _fact(v=1, filed="2026-02-10", a="0000000001-26-000009")]
    assert [(f["v"], f["filed"]) for f in sf.dedup_facts(back)] == [(1, "2026-01-10")]


def test_같은_날_원본과_정정이면_접수_번호_앞자리와_관계없이_정정_값을_남긴다():
    # 접수 번호 앞 10자리는 제출자(대행사) CIK라 사전순이 접수 순서가 아닙니다 — 원본(대행사 0001628280)이 정정(회사 자신
    # 0000320193)보다 사전순으로 뒤라도 그날 남는 값은 정정(/A)입니다(백엔드 Fundamentals.LATER와 같은 순서).
    same_day = [_fact(v=9, filed="2026-07-01", a="0000320193-26-000010"),
                _fact(v=10, filed="2026-08-01", a="0001628280-26-000500", f="10-Q"),
                _fact(v=12, filed="2026-08-01", a="0000320193-26-000020", f="10-Q/A")]
    kept = sf.dedup_facts(same_day)
    assert [(f["v"], f["f"], f["filed"]) for f in kept] == [(9, "10-Q", "2026-07-01"), (12, "10-Q/A", "2026-08-01")]
    # 입력 순서를 바꿔도 같음
    assert sf.dedup_facts(list(reversed(same_day))) == kept


def test_공시일마다_한_행이고_payload는_계약_모양이다():
    facts = sf.dedup_facts(sf.extract_facts(_doc("companyfacts_aapl.json"), AAPL))
    rows = sf.group_by_filed(facts, [AAPL])

    assert list(rows) == ["2020-10-30", "2025-01-31", "2025-05-02", "2025-08-01", "2025-10-31", "2026-05-01", "2026-07-31"]
    accn = "0000320193-26-000020"

    def q3(t, c, u, s, e, v):
        return {"t": t, "c": c, "u": u, "s": s, "e": e, "v": v, "f": "10-Q", "a": accn, "fy": 2026, "fp": "Q3"}

    assert rows["2026-07-31"] == {"cik": [AAPL], "facts": [
        q3("dei", "EntityCommonStockSharesOutstanding", "shares", None, "2026-07-17", 14594180000),
        q3("us-gaap", "Assets", "USD", None, "2026-06-27", 383266000000),
        q3("us-gaap", "NetCashProvidedByUsedInOperatingActivities", "USD", "2025-09-28", "2026-06-27", 116996000000),
        q3("us-gaap", "NetIncomeLoss", "USD", "2026-03-29", "2026-06-27", 29789000000),
        q3("us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax", "USD", "2025-09-28", "2026-06-27", 364357000000),
        q3("us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax", "USD", "2026-03-29", "2026-06-27", 109417000000),
    ]}


def test_별칭_CIK를_합치면_새_CIK의_비교_열은_버려지고_행마다_낸_CIK를_적는다():
    merged = sf.extract_facts(_doc("companyfacts_xom_new.json"), XOM_NEW) + \
        sf.extract_facts(_doc("companyfacts_xom_old.json"), XOM_OLD)
    rows = sf.group_by_filed(sf.dedup_facts(merged), [XOM_NEW, XOM_OLD])

    assert {day: (row["cik"], [(f["s"], f["e"]) for f in row["facts"]]) for day, row in rows.items()} == {
        "2025-08-04": ([XOM_OLD], [("2025-04-01", "2025-06-30")]),
        "2026-05-04": ([XOM_OLD], [("2026-01-01", "2026-03-31")]),
        "2026-08-03": ([XOM_NEW], [("2026-04-01", "2026-06-30")]),
    }


def test_같은_날_두_CIK의_사실은_한_행에_합친다():
    facts = [_fact(c="Assets", s=None, e="2026-06-30", v=10, cik="0000000002", filed="2026-08-03"),
             _fact(c="NetIncomeLoss", v=3, cik="0000000001", filed="2026-08-03")]
    rows = sf.group_by_filed(sf.dedup_facts(facts), ["0000000001", "0000000002"])
    assert list(rows) == ["2026-08-03"]
    assert rows["2026-08-03"]["cik"] == ["0000000001", "0000000002"], "CIK는 회사 목록 순서(지금 법인이 앞)"
    assert [f["c"] for f in rows["2026-08-03"]["facts"]] == ["Assets", "NetIncomeLoss"]


def test_요약의_최신_기간_end는_dei_표지_기준일이_아니라_재무제표_사실에서():
    aapl = sf.summarize(sf.dedup_facts(sf.extract_facts(_doc("companyfacts_aapl.json"), AAPL)))
    assert aapl == {"latestFiled": "2026-07-31", "latestEnd": "2026-06-27", "latestAnnualEnd": "2025-09-27",
                    "taxonomy": "us-gaap", "currency": "USD", "facts": 14}
    sap = sf.summarize(sf.dedup_facts(sf.extract_facts(_doc("companyfacts_sap.json"), SAP)))
    assert (sap["taxonomy"], sap["currency"], sap["latestEnd"]) == ("ifrs-full", "EUR", "2025-12-31")
    assert sf.summarize([]) == {"latestFiled": None, "latestEnd": None, "latestAnnualEnd": None,
                                "taxonomy": None, "currency": None, "facts": 0}


# ==============================================================================
# 3. 티커 → CIK, 별칭표
# ==============================================================================
class _Response:
    def __init__(self, status: int = 200, body=None):
        self.status_code = status
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("Expecting value")
        return copy.deepcopy(self._body)


class FakeSec:
    """company_tickers.json과 CIK별 companyfacts를 돌려주고 요청 URL을 남기는 가짜 SEC 세션."""

    def __init__(self):
        self.tickers = _doc("company_tickers.json")
        alphabet = _wrap("NetIncomeLoss", "USD", [
            {"start": "2026-04-01", "end": "2026-06-30", "val": 28196000000, "accn": "0001652044-26-000066",
             "fy": 2026, "fp": "Q2", "form": "10-Q", "filed": "2026-07-24"}])
        self.docs = {AAPL: _doc("companyfacts_aapl.json"), GOOG: alphabet, GPRO: _doc("companyfacts_gpro.json"),
                     SAP: _doc("companyfacts_sap.json"), XOM_NEW: _doc("companyfacts_xom_new.json"),
                     XOM_OLD: _doc("companyfacts_xom_old.json")}
        self.broken: set[str] = set()
        self.tickers_broken = False
        self.calls: list[str] = []

    def get(self, url, timeout=None, params=None):
        self.calls.append(url)
        if url == sf.COMPANY_TICKERS_URL:
            return _Response(503) if self.tickers_broken else _Response(200, self.tickers)
        cik = url.rsplit("CIK", 1)[1].split(".")[0]
        if cik in self.broken:
            return _Response(500)
        if cik not in self.docs:
            return _Response(404)
        return _Response(200, self.docs[cik])

    def facts_calls(self) -> list[str]:
        return [url.rsplit("CIK", 1)[1].split(".")[0] for url in self.calls if "companyfacts" in url]


def test_목록은_티커_대문자_CIK_10자리이고_같은_티커는_앞의_행을_쓴다():
    mapping = sf.fetch_company_tickers(FakeSec())
    assert mapping["AAPL"] == AAPL
    assert mapping["GOOG"] == mapping["GOOGL"] == GOOG
    assert len(mapping) == 8


def test_별칭표는_지금_CIK_뒤에_옛_CIK를_잇고_매핑이_없어도_쓴다():
    mapping = sf.fetch_company_tickers(FakeSec())
    assert sf.resolve_ciks("XOM", mapping) == [XOM_NEW, XOM_OLD]
    assert sf.resolve_ciks("BLK", {}) == ["0002012383", "0001364742"]
    assert sf.resolve_ciks("ZZZZ", mapping) == []
    assert sf.resolve_ciks("AAPL", mapping) == [AAPL]


def test_별칭표는_확인한_세_곳이고_CIK는_10자리():
    assert set(sf.FUNDAMENTALS_CIK_ALIASES) == {"XOM", "BLK", "FERG"}
    for ticker, ciks in sf.FUNDAMENTALS_CIK_ALIASES.items():
        assert len(ciks) == len(set(ciks)) >= 2, ticker
        assert all(len(c) == 10 and c.isdigit() for c in ciks), ticker
    assert sf.FUNDAMENTALS_CIK_ALIASES["XOM"] == [XOM_NEW, XOM_OLD]


def test_한_CIK라도_404가_아닌_실패면_회사_전체를_저장하지_않는다(monkeypatch):
    monkeypatch.setattr(sf, "sec_rate_limit", lambda: None)
    fake = FakeSec()
    fake.broken.add(XOM_OLD)
    result = sf.collect_company([XOM_NEW, XOM_OLD], fake)
    assert result.rows == {} and result.error.startswith(XOM_OLD) and "500" in result.error
    assert result.requests == 2 and not result.no_companyfacts

    fake.broken.clear()
    del fake.docs[XOM_OLD]
    partial = sf.collect_company([XOM_NEW, XOM_OLD], fake)
    assert partial.error is None and list(partial.rows) == ["2026-08-03"], "옛 CIK 404는 그 CIK만 비어 있는 것"

    nothing = sf.collect_company([IBN], fake)
    assert (nothing.error, nothing.no_companyfacts, nothing.rows) == ("no companyfacts", True, {})


def test_403은_UA_안내를_붙이되_값은_싣지_않는다(monkeypatch):
    monkeypatch.setattr(sf, "sec_rate_limit", lambda: None)

    class _Forbidden:
        def get(self, url, timeout=None):
            return _Response(403)

    with pytest.raises(sf.FetchError) as caught:
        sf.fetch_companyfacts(AAPL, _Forbidden())
    assert "403" in str(caught.value) and "SEC_USER_AGENT" in str(caught.value)
    assert "@" not in str(caught.value)


def test_ETP_집합은_CUSIP_매핑표의_ETP_주석과_같다():
    # 표의 주석(OpenFIGI 종류)과 집합이 어긋나면 ETF가 재무 수집·패킷 대상에 '재무 없음'으로 남거나 회사가 빠집니다.
    from app import equities_cusip

    source = (Path(equities_cusip.__file__)).read_text(encoding="utf-8")
    marked = set(re.findall(r'"[0-9A-Z]{9}": "([A-Z.\-]+)",\s*#[^\n]*· ETP\b', source))
    assert marked and marked == set(equities_cusip.TRACK_RECORD_ETPS)
    assert marked <= set(equities_cusip.TRACK_RECORD_CUSIPS.values())


# ==============================================================================
# 4. 순서 (네트워크·DB 없음)
# ==============================================================================
def test_다음_공시_마감은_분기_40일_회계연도_말이면_75일():
    # 3월 말까지 받은 회사: 6월 말 분기의 10-Q 마감 08-09가 지났고 9월 말 분기 마감(11-08)은 아직
    assert task_module.latest_due("2026-03-31", "2025-12-31", TODAY) == date(2026, 8, 9)
    # 6월 말까지 받은 12월 결산 회사: 다음은 9월 말(11-08), 그다음은 회계연도 말 12월 → +75일(2027-03-14)
    assert task_module.latest_due("2026-06-30", "2025-12-31", date(2027, 3, 1)) == date(2026, 11, 8)
    assert task_module.latest_due("2026-06-30", "2025-12-31", date(2027, 3, 20)) == date(2027, 3, 14)
    assert task_module.latest_due("2026-09-30", "2025-12-31", TODAY) is None
    assert task_module.latest_due(None, None, TODAY) is None


def test_순서는_받은_적_없음_새_공시_오래된_순_같은_순위는_티커():
    targets = {t: ["0000000001"] for t in ("NEW", "CHG", "DUE", "OLD", "OLDER", "ZNEW")}
    previous = {
        "CHG": {"ciks": ["0000000009"], "fetchedAt": "2026-10-24T00:00:00+00:00", "latestEnd": "2026-06-30"},
        "DUE": {"ciks": ["0000000001"], "fetchedAt": "2026-08-01T00:00:00+00:00", "latestEnd": "2026-03-31",
                "latestAnnualEnd": "2025-12-31"},
        "OLD": {"ciks": ["0000000001"], "fetchedAt": "2026-10-01T00:00:00+00:00", "latestEnd": "2026-06-30"},
        "OLDER": {"ciks": ["0000000001"], "fetchedAt": "2026-09-01T00:00:00+00:00", "latestEnd": "2026-06-30"},
        "ZNEW": {"ciks": ["0000000001"], "fetchedAt": None, "error": "SEC 응답 500"},
    }
    assert task_module.priority_order(targets, previous, TODAY) == ["CHG", "NEW", "ZNEW", "DUE", "OLDER", "OLD"]


def test_시간_상한은_weekly_태스크_상한보다_짧다():
    assert task_module.TIME_LIMIT_SECONDS < tasks.TASK_DEADLINE_SECONDS["weekly"]


def test_예산_설정은_1에서_600으로_자르고_잘못된_값은_기본값(monkeypatch):
    for raw, expected in (("", 200), ("abc", 200), ("0", 1), ("-5", 1), ("5000", 600), (" 250 ", 250)):
        monkeypatch.setenv("FUNDAMENTALS_FETCH_BUDGET", raw)
        assert settings.fundamentals_fetch_budget() == expected, raw
    monkeypatch.delenv("FUNDAMENTALS_FETCH_BUDGET")
    assert settings.fundamentals_fetch_budget() == 200


def test_weekly에_등록되고_태스크는_30개():
    task = tasks.TASKS_BY_NAME["sec_fundamentals"]
    assert task.speed == "weekly" and task.run is task_module.task_sec_fundamentals
    assert len(tasks.ALL_TASKS) == len(tasks.TASKS_BY_NAME) == 30  # 2단계 A의 us_calendar·B의 news_headlines·C의 earnings_surprise·v2 B3의 fsc_etf_prices·v2 B4의 kr_paper_universe·kr_paper_quotes까지


# ==============================================================================
# 5. 태스크 (PostgreSQL)
# ==============================================================================
UNIVERSE = ("AAPL", "GOOG", "GOOGL", "GPRO", "IBN", "SAP", "SPY", "XOM", "ZZZZ")


@pytest.fixture()
def sec(monkeypatch):
    monkeypatch.setenv("SEC_USER_AGENT", "test@example.com")
    monkeypatch.delenv("FUNDAMENTALS_FETCH_BUDGET", raising=False)
    monkeypatch.setattr(paper_universe, "tradable", lambda: UNIVERSE)
    fake = FakeSec()
    monkeypatch.setattr(sf, "get_sec_session", lambda: fake)
    monkeypatch.setattr(sf, "sec_rate_limit", lambda: None)
    monkeypatch.setattr(task_module, "_today", lambda: TODAY)
    assert "SPY" in indicators.PAPER_ETFS
    return fake


def _rows(store, ticker: str) -> list[dict]:
    with store.connection() as conn:
        rows = conn.execute(
            "SELECT obs_date, payload, updated_at FROM observations WHERE dataset = %s AND entity = %s ORDER BY obs_date",
            (catalog.OBS_US_FUNDAMENTALS, ticker),
        ).fetchall()
    return [{"date": r["obs_date"].isoformat(), "payload": r["payload"], "updated_at": r["updated_at"]} for r in rows]


def _status(store) -> dict:
    return store.read_snapshot(catalog.SNAP_US_FUNDAMENTALS_STATUS).payload


def test_회사마다_공시일_행과_상태_스냅샷을_남긴다(store, sec):
    detail = task_module.task_sec_fundamentals()

    assert detail.startswith("7/7 종목 갱신(요청 7/200건"), detail
    assert "companyfacts 없음 1" in detail
    # GOOG·GOOGL은 같은 CIK — 한 번만 받습니다. ETF(SPY)·매핑 안 됨(ZZZZ)은 요청하지 않습니다.
    assert sorted(sec.facts_calls()) == sorted([AAPL, GOOG, GPRO, IBN, SAP, XOM_NEW, XOM_OLD])

    aapl = _rows(store, "AAPL")
    assert [r["date"] for r in aapl] == ["2020-10-30", "2025-01-31", "2025-05-02", "2025-08-01", "2025-10-31",
                                         "2026-05-01", "2026-07-31"]
    assert aapl[-1]["payload"]["cik"] == [AAPL] and len(aapl[-1]["payload"]["facts"]) == 6
    assert set(aapl[-1]["payload"]) == {"cik", "facts"}
    assert [r["date"] for r in _rows(store, "GOOG")] == [r["date"] for r in _rows(store, "GOOGL")] == ["2026-07-24"]
    assert [(r["date"], r["payload"]["cik"]) for r in _rows(store, "XOM")] == [
        ("2025-08-04", [XOM_OLD]), ("2026-05-04", [XOM_OLD]), ("2026-08-03", [XOM_NEW])]
    assert _rows(store, "IBN") == [] and _rows(store, "SPY") == []

    status = _status(store)
    assert {k: status[k] for k in ("universe", "mapped", "fetchedThisRun", "failedThisRun", "budget",
                                   "requestsThisRun", "unmapped")} == {
        "universe": 8, "mapped": 7, "fetchedThisRun": 7, "failedThisRun": 0, "budget": 200, "requestsThisRun": 7,
        "unmapped": ["ZZZZ"]}
    companies = status["companies"]
    assert sorted(companies) == ["AAPL", "GOOG", "GOOGL", "GPRO", "IBN", "SAP", "XOM"]  # jsonb는 키 순서를 두지 않음
    assert companies["AAPL"] == {
        "ciks": [AAPL], "fetchedAt": companies["AAPL"]["fetchedAt"], "latestFiled": "2026-07-31",
        "latestEnd": "2026-06-27", "latestAnnualEnd": "2025-09-27", "taxonomy": "us-gaap", "currency": "USD",
        "facts": 14, "error": None}
    assert companies["AAPL"]["fetchedAt"]
    assert (companies["SAP"]["taxonomy"], companies["SAP"]["currency"]) == ("ifrs-full", "EUR")
    assert companies["XOM"]["ciks"] == [XOM_NEW, XOM_OLD]
    assert companies["IBN"]["error"] == "no companyfacts" and companies["IBN"]["facts"] == 0
    assert companies["IBN"]["latestFiled"] is None and companies["IBN"]["fetchedAt"]


def test_같은_내용을_다시_받으면_행을_다시_쓰지_않는다(store, sec):
    task_module.task_sec_fundamentals()
    before = {r["date"]: r["updated_at"] for r in _rows(store, "AAPL")}

    task_module.task_sec_fundamentals()

    after = {r["date"]: r["updated_at"] for r in _rows(store, "AAPL")}
    assert after == before


def test_정정_공시로_바뀐_값은_새_공시일_행으로_더해지고_옛_행은_남는다(store, sec):
    # 첫 실행 때는 10-K/A(2026-10-19)가 아직 없었다고 봅니다.
    original = sec.docs[GPRO]
    trimmed = copy.deepcopy(original)
    rows = trimmed["facts"]["us-gaap"]["NetIncomeLoss"]["units"]["USD"]
    trimmed["facts"]["us-gaap"]["NetIncomeLoss"]["units"]["USD"] = [r for r in rows if r["form"] != "10-K/A"]
    sec.docs[GPRO] = trimmed
    task_module.task_sec_fundamentals()
    assert [r["date"] for r in _rows(store, "GPRO")] == ["2025-11-06", "2026-02-27"]

    sec.docs[GPRO] = original
    task_module.task_sec_fundamentals()

    gpro = _rows(store, "GPRO")
    assert [r["date"] for r in gpro] == ["2025-11-06", "2026-02-27", "2026-10-19"]
    assert sorted(f["v"] for f in gpro[-1]["payload"]["facts"]) == [-90549000, -27418000]
    assert sorted(f["v"] for f in gpro[0]["payload"]["facts"]) == [-84383000, -21252000], "처음 낸 값은 그대로"


def test_예산은_요청_수이고_별칭_회사는_모자라면_통째로_다음_실행(store, sec, monkeypatch):
    monkeypatch.setenv("FUNDAMENTALS_FETCH_BUDGET", "3")

    first = task_module.task_sec_fundamentals()

    # 받은 적 없는 종목을 티커 순으로: AAPL(1) · GOOG(1, GOOGL은 같은 CIK라 공짜) · GPRO(1) → 예산 3
    assert sec.facts_calls() == [AAPL, GOOG, GPRO]
    assert sorted(_status(store)["companies"]) == ["AAPL", "GOOG", "GOOGL", "GPRO"]
    assert "예산 소진 — 3곳은 다음 실행" in first, first

    sec.calls.clear()
    task_module.task_sec_fundamentals()
    # ① 받은 적 없는 IBN·SAP, XOM은 CIK 둘이라 남은 1건으로는 받지 않고, ③ 가장 오래전에 받은 AAPL로 채움
    assert sec.facts_calls() == [IBN, SAP, AAPL]
    assert "XOM" not in _status(store)["companies"]

    sec.calls.clear()
    task_module.task_sec_fundamentals()
    assert sec.facts_calls()[:2] == [XOM_NEW, XOM_OLD], "다음 실행에는 ①이라 맨 앞"
    assert _status(store)["companies"]["XOM"]["facts"] == 3


def test_일부_실패는_상태를_이어받아_isStale이고_행은_그대로(store, sec):
    task_module.task_sec_fundamentals()
    first = _status(store)["companies"]["AAPL"]
    rows_before = _rows(store, "AAPL")
    sec.broken.add(AAPL)

    detail = task_module.task_sec_fundamentals()

    status = _status(store)
    carried = status["companies"]["AAPL"]
    assert carried["isStale"] is True and "500" in carried["staleReason"] and carried["staleSince"]
    assert {k: carried[k] for k in first} == first, "이전 값 그대로(받은 시각 포함)"
    assert (status["fetchedThisRun"], status["failedThisRun"]) == (6, 1)
    assert _rows(store, "AAPL") == rows_before
    assert "실패 1곳" in detail and "이전 값 1개(AAPL)" in detail, detail

    sec.broken.clear()
    task_module.task_sec_fundamentals()
    assert "isStale" not in _status(store)["companies"]["AAPL"], "다시 받으면 새 줄"


def test_이어받을_값이_없는_실패는_오류만_적고_다음_실행_맨_앞에서_다시_시도한다(store, sec):
    sec.broken.add(SAP)

    task_module.task_sec_fundamentals()

    entry = _status(store)["companies"]["SAP"]
    assert entry["error"].startswith(SAP) and "500" in entry["error"]
    assert entry["fetchedAt"] is None and entry["facts"] is None and entry["latestEnd"] is None, "모르는 값은 null"
    assert _rows(store, "SAP") == []

    sec.broken.clear()
    sec.calls.clear()
    task_module.task_sec_fundamentals()
    assert sec.facts_calls()[0] == SAP
    assert _status(store)["companies"]["SAP"]["error"] is None


def test_자료가_있던_회사의_404는_일시_장애로_보고_이어받는다(store, sec):
    task_module.task_sec_fundamentals()
    del sec.docs[AAPL]

    task_module.task_sec_fundamentals()

    entry = _status(store)["companies"]["AAPL"]
    assert entry["isStale"] is True and entry["staleReason"] == "no companyfacts" and entry["facts"] == 14


def test_전부_실패하면_EmptyResult이고_상태를_덮지_않으며_연속_5번_실패에서_멈춘다(store, sec):
    task_module.task_sec_fundamentals()
    snapshot = _status(store)
    sec.broken.update({AAPL, GOOG, GPRO, IBN, SAP, XOM_NEW, XOM_OLD})
    sec.calls.clear()

    with pytest.raises(EmptyResult) as caught:
        task_module.task_sec_fundamentals()

    assert "0/7 종목 — 기존 저장본 유지" in str(caught.value)
    assert _status(store) == snapshot
    # 가장 오래전에 받은 순: AAPL · GOOG(GOOGL은 같은 결과) · GPRO · IBN · SAP에서 연속 5번 → 한 곳도 못 받았으니 가장 최근에
    # 받은 정상 회사(XOM) 하나로 SEC를 확인하고, 그것도 실패해 멈춥니다(XOM의 둘째 CIK는 첫 CIK 실패로 요청하지 않음).
    assert sec.facts_calls() == [AAPL, GOOG, GPRO, IBN, SAP, XOM_NEW]


def test_시간_상한을_넘기면_새_회사를_시작하지_않고_받은_만큼_기록한다(store, sec, monkeypatch):
    ticks = iter([0.0, 0.0])
    monkeypatch.setattr(task_module, "_clock", lambda: next(ticks, 5000.0))

    detail = task_module.task_sec_fundamentals()

    assert sec.facts_calls() == [AAPL]
    assert sorted(_status(store)["companies"]) == ["AAPL"]
    assert "시간 상한(1200초) — 6곳은 다음 실행" in detail, detail


def test_목록을_못_받으면_직전_상태의_CIK로_간다(store, sec):
    task_module.task_sec_fundamentals()
    sec.tickers_broken = True
    sec.calls.clear()

    detail = task_module.task_sec_fundamentals()

    assert sorted(sec.facts_calls()) == sorted([AAPL, GOOG, GPRO, IBN, SAP, XOM_NEW, XOM_OLD])
    assert "company_tickers.json" in detail and "503" in detail


def test_목록도_직전_상태도_없으면_EmptyResult(store, sec):
    sec.tickers_broken = True
    with pytest.raises(EmptyResult, match="CIK 목록을 받지 못했고"):
        task_module.task_sec_fundamentals()
    assert store.read_snapshot(catalog.SNAP_US_FUNDAMENTALS_STATUS) is None


def test_UA가_없거나_틀리면_요청_없이_멈추고_값은_싣지_않는다(store, sec, monkeypatch):
    monkeypatch.setenv("SEC_USER_AGENT", "홍길동 비밀주소@회사")
    with pytest.raises(EmptyResult) as caught:
        task_module.task_sec_fundamentals()
    assert "홍길동" not in str(caught.value) and "@" not in str(caught.value)

    monkeypatch.delenv("SEC_USER_AGENT")
    with pytest.raises(EmptyResult, match="미설정"):
        task_module.task_sec_fundamentals()
    assert sec.calls == []


def test_상태_저장본이_없으면_누락_데이터셋에_보인다(store):
    assert catalog.SNAP_US_FUNDAMENTALS_STATUS in {entry["name"] for entry in store.missing_datasets()}


def _many_companies(sec, monkeypatch, n: int) -> tuple[list[str], dict[str, str]]:
    """티커 T00…(n개)와 CIK를 가짜 SEC에 심습니다 — 문서는 회사마다 2분기 순이익 하나(최신 end 2026-06-30, 순서 ②가 생기지 않음)."""
    tickers = [f"T{i:02d}" for i in range(n)]
    ciks = {t: f"{9_000_000 + i:010d}" for i, t in enumerate(tickers)}
    monkeypatch.setattr(paper_universe, "tradable", lambda: tuple(tickers))
    sec.tickers = {str(i): {"cik_str": int(ciks[t]), "ticker": t, "title": t} for i, t in enumerate(tickers)}
    sec.docs = {cik: _wrap("NetIncomeLoss", "USD", [
        {"start": "2026-04-01", "end": "2026-06-30", "val": 100 + i, "accn": f"{cik}-26-000001", "fy": 2026, "fp": "Q2",
         "form": "10-Q", "filed": "2026-08-03"}]) for i, cik in enumerate(ciks.values())}
    return tickers, ciks


def test_계속_실패하는_회사_5곳이_태스크를_멈추지_않는다(store, sec, monkeypatch):
    tickers, ciks = _many_companies(sec, monkeypatch, 12)
    task_module.task_sec_fundamentals()   # 모두 받음(받은 시각 = 티커 순)
    broken = tickers[:5]                  # 가장 오래전에 받은 5곳 — 다음 실행 순서의 맨 앞
    sec.broken.update(ciks[t] for t in broken)
    sec.calls.clear()

    # 처음 겪는 실패 5곳에서 상한에 걸려도, 가장 최근에 받은 정상 회사(T11)로 SEC가 살아 있음을 확인하고 이어서 받습니다.
    detail = task_module.task_sec_fundamentals()
    assert sec.facts_calls() == [ciks[t] for t in broken] + [ciks["T11"]] + [ciks[t] for t in tickers[5:11]]
    assert detail.startswith("7/12 종목 갱신"), detail
    status = _status(store)
    assert (status["fetchedThisRun"], status["failedThisRun"]) == (7, 5)
    assert all(status["companies"][t]["isStale"] for t in broken), "실패한 5곳은 이전 값을 이어받아 실패로 남음"

    # 다음 실행 — 이미 실패로 적힌 5곳은 연속 실패로 세지 않으므로 확인 요청 없이 순서대로 받습니다.
    sec.calls.clear()
    detail = task_module.task_sec_fundamentals()
    assert sec.facts_calls() == [ciks[t] for t in broken] + [ciks["T11"]] + [ciks[t] for t in tickers[5:11]]
    assert detail.startswith("7/12 종목 갱신"), detail
    assert "연속 실패" not in detail


def test_티커의_CIK가_바뀌면_옛_CIK로_쌓은_행을_지우고_실패하면_지우지_않는다(store, sec):
    task_module.task_sec_fundamentals()
    xom_before = _rows(store, "XOM")
    assert len(_rows(store, "AAPL")) == 7

    # AAPL 티커가 다른 회사(CIK 777)로 다시 배정됨 — 옛 회사의 행이 남으면 백엔드가 cik를 보지 않고 합칩니다.
    new_cik = "0000000777"
    sec.tickers["0"]["cik_str"] = 777
    sec.docs[new_cik] = _wrap("NetIncomeLoss", "USD", [
        {"start": "2026-04-01", "end": "2026-06-30", "val": 5, "accn": "0000000777-26-000001", "fy": 2026, "fp": "Q2",
         "form": "10-Q", "filed": "2026-08-01"}])
    task_module.task_sec_fundamentals()

    aapl = _rows(store, "AAPL")
    assert [(r["date"], r["payload"]["cik"]) for r in aapl] == [("2026-08-01", [new_cik])]
    assert _status(store)["companies"]["AAPL"]["ciks"] == [new_cik]
    assert _rows(store, "XOM") == xom_before, "별칭 두 CIK의 행은 둘 다 목록에 있어 그대로"

    # 다시 바뀌었는데 새 CIK가 실패하면 아무것도 지우지 않습니다(받지 못한 회사의 행은 그대로).
    sec.tickers["0"]["cik_str"] = 888
    sec.broken.add("0000000888")
    task_module.task_sec_fundamentals()
    assert _rows(store, "AAPL") == aapl


def test_13F_매핑표의_ETF는_재무_대상이_아니다(store, sec, monkeypatch):
    # IVV(iShares 신탁)는 CIK가 잡혀도 재무제표가 없는 ETF — 요청하지 않고 universe에도 세지 않습니다.
    monkeypatch.setattr(paper_universe, "tradable", lambda: (*UNIVERSE, "IVV"))
    sec.tickers["9"] = {"cik_str": 1100663, "ticker": "IVV", "title": "ISHARES TRUST"}
    sec.docs["0001100663"] = sec.docs[GOOG]

    task_module.task_sec_fundamentals()

    assert "0001100663" not in sec.facts_calls()
    status = _status(store)
    assert "IVV" not in status["companies"] and "IVV" not in status["unmapped"]
    assert status["universe"] == 8
