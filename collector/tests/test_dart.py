"""
tests/test_dart.py
Open DART 고유번호·주요계정.

응답 형태의 근거 — 실제 응답 표본은 없습니다(이 개발 환경에서 DART에 접속 불가).
아래 최소 응답은 공식 개발가이드의 필드 정의(kenshin579/opendart-go docs/api에
옮겨진 것)와 OpenDartReader가 CORPCODE.xml을 읽는 방식(`list` 요소 아래
corp_code·corp_name·stock_code)만으로 구성했습니다. 계정명은 가이드의 예시
("자본총계")와 괄호 표기 변형을 씁니다.

고정하는 규칙
  1. 고유번호 표는 상장사(6자리 종목코드)만 남긴다.
  2. 연결(CFS)이 있으면 연결, 없으면 별도(OFS).
  3. 금액 "1,234" → 1234, 빈 값·"-" → None (0으로 채우지 않는다).
  4. status 013(데이터 없음)은 빈 목록, 그 밖의 오류는 키가 지워진 사유로 실패.
  5. 비정상적으로 큰 ZIP은 풀지 않는다.
  6. 재무 대상은 한국 책 수집 범위(U 순위 → 끈적 목록, ETF 2 제외)가 먼저, 수급 레이더 종목이 뒤 — 레이더 몫은 예전 그대로이고
     두 상한의 합은 두 연도를 다 물어도 호출 예산 안(v2 2단계 명세 §4-5 B8).
"""
from __future__ import annotations

import io
import zipfile
from types import SimpleNamespace

import pytest

from app import publicapi
from app.services import dart

KEY = "0123456789abcdef0123456789abcdef01234567"


def _zip(xml: str, name: str = "CORPCODE.xml") -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(name, xml)
    return buffer.getvalue()


CORPCODE = """<?xml version="1.0" encoding="UTF-8"?>
<result>
  <list><corp_code>00126380</corp_code><corp_name>삼성전자</corp_name><stock_code>005930</stock_code><modify_date>20240101</modify_date></list>
  <list><corp_code>00999999</corp_code><corp_name>비상장회사</corp_name><stock_code> </stock_code><modify_date>20240101</modify_date></list>
</result>"""


def test_고유번호는_상장사만_남긴다():
    table = dart.parse_corp_codes(_zip(CORPCODE))
    assert table == {"005930": {"corpCode": "00126380", "name": "삼성전자"}}


def test_큰_ZIP은_풀지_않는다(monkeypatch):
    monkeypatch.setattr(dart, "_MAX_XML_BYTES", 10)
    with pytest.raises(publicapi.PublicApiError, match="비정상적으로 큽니다"):
        dart.parse_corp_codes(_zip(CORPCODE))


def test_ZIP_대신_오류가_오면_사유를_보여_준다(monkeypatch):
    body = '{"status":"010","message":"등록되지 않은 키입니다."}'.encode()
    monkeypatch.setattr(dart.settings, "dart_key", lambda: KEY)
    monkeypatch.setattr(dart.publicapi, "get", lambda *a, **k: SimpleNamespace(content=body, status_code=200))
    with pytest.raises(publicapi.PublicApiError, match="status=010 등록되지 않은 키"):
        dart.fetch_corp_codes()


def _row(stock, fs_div, account, current, previous="", before=""):
    return {
        "rcept_no": "20250311000001", "bsns_year": "2024", "stock_code": stock, "reprt_code": "11011",
        "account_nm": account, "fs_div": fs_div, "sj_div": "BS", "thstrm_amount": current,
        "frmtrm_amount": previous, "bfefrmtrm_amount": before, "currency": "KRW",
    }


def test_연결이_있으면_연결을_쓰고_금액을_숫자로_바꾼다():
    rows = [
        _row("005930", "OFS", "자본총계", "100"),
        _row("005930", "CFS", "자본총계", "1,000", "900", "800"),
        _row("005930", "CFS", "당기순이익(손실)", "-1,234", "-", ""),
        _row("000660", "OFS", "부채총계", "50"),
    ]
    grouped = dart.group_by_company(rows)

    samsung = grouped["005930"]
    assert samsung["fsDiv"] == "CFS"
    assert samsung["accounts"]["자본총계"]["current"] == 1000.0
    assert samsung["accounts"]["자본총계"]["beforePrevious"] == 800.0
    # 괄호 표기는 정규화하되 원문은 남깁니다.
    net = samsung["accounts"]["당기순이익"]
    assert net["rawName"] == "당기순이익(손실)"
    assert net["current"] == -1234.0 and net["previous"] is None and net["beforePrevious"] is None
    # 연결이 없는 회사는 별도.
    assert grouped["000660"]["fsDiv"] == "OFS"


@pytest.mark.parametrize("text,expected", [("1,234", 1234.0), ("-5", -5.0), ("", None), ("-", None), (None, None), ("N/A", None)])
def test_금액_파싱(text, expected):
    assert dart.parse_amount(text) == expected


def test_status_013은_빈_목록():
    response = SimpleNamespace(json=lambda: {"status": "013", "message": "조회된 데이타가 없습니다."}, text="", status_code=200)
    assert dart._json(response, KEY) == {"status": "013", "list": []}


def test_그_밖의_status는_키를_지운_사유로_실패():
    response = SimpleNamespace(json=lambda: {"status": "020", "message": f"요청 제한 초과 {KEY}"}, text="", status_code=200)
    with pytest.raises(publicapi.PublicApiError) as info:
        dart._json(response, KEY)
    assert "status=020" in str(info.value) and KEY not in str(info.value)


def test_사업보고서_기준_연도():
    from datetime import date

    from app import tasks
    assert tasks._latest_annual_year(date(2026, 3, 31)) == 2024  # 3월엔 작년 보고서가 없는 회사가 많음
    assert tasks._latest_annual_year(date(2026, 4, 1)) == 2025


# ------------------------------------------------------------------ 태스크
class _FakeStore:
    def __init__(self, snapshots=None, codes=None, universe=None):
        self.snapshots = dict(snapshots or {})
        self.codes = codes or []
        self.universe = dict(universe or {})   # 기준일 → 한국 책 유니버스(kr_paper_universe) 행

    def read_snapshot(self, name):
        from datetime import datetime, timezone
        payload = self.snapshots.get(name)
        return SimpleNamespace(payload=payload, collected_at=datetime.now(timezone.utc)) if payload else None

    def put_snapshot(self, name, payload):
        self.snapshots[name] = payload

    def recent_observation_codes(self, dataset, since, limit):
        return list(self.codes)[:limit]

    # 한국 책 수집 범위(kr_paper.kr_scope)가 읽는 자리
    def latest_observation_date(self, dataset):
        return max(self.universe) if self.universe and dataset == _universe_dataset() else None

    def read_observations(self, dataset, *, obs_date=None, **_):
        return list(self.universe.get(obs_date) or []) if dataset == _universe_dataset() else []

    def observation_entities_since(self, dataset, since):
        if dataset != _universe_dataset():
            return set()
        return {row["code"] for day, rows in self.universe.items() if day >= since for row in rows}


def _universe_dataset():
    from app import catalog
    return catalog.OBS_KR_PAPER_UNIVERSE


@pytest.fixture(autouse=True)
def _no_kr_universe(monkeypatch):
    """
    기본은 한국 책 유니버스 저장본이 없는 상태(레이더 종목만 — B8 전 동작)입니다. 한국 범위는 kr_paper 모듈의 store로 읽으므로
    korea_public.store만 바꿔 끼운 시험이 실제 DB를 읽지 않게 막습니다. 한국 범위를 보는 시험은 같은 가짜를 두 모듈에 끼웁니다.
    """
    from app import tasks
    monkeypatch.setattr(tasks.kr_paper, "store", _FakeStore())


def test_최신_연도에_없는_회사만_전년도로_다시_받는다(monkeypatch):
    from app import catalog, tasks

    fake = _FakeStore(
        snapshots={catalog.SNAP_DART_CORP_CODES: {"codes": {
            "005930": {"corpCode": "00126380", "name": "삼성전자"},
            "000660": {"corpCode": "00164779", "name": "SK하이닉스"},
        }}},
        codes=["005930", "000660", "069500"],  # 069500(ETF)은 DART 대상이 아님
    )
    monkeypatch.setattr(tasks.korea_public, "store", fake)
    calls = []

    def fetch(corp_codes, year):
        calls.append((tuple(corp_codes), year))
        latest = tasks._latest_annual_year(__import__("datetime").datetime.now(tasks.KST).date())
        if year == latest:
            return [_row("005930", "CFS", "자본총계", "10")]
        return [_row("000660", "CFS", "자본총계", "5")]

    monkeypatch.setattr(tasks.dart_service, "fetch_accounts", fetch)
    result = tasks.task_dart_fundamentals()

    saved = fake.snapshots[catalog.SNAP_DART_FUNDAMENTALS]
    assert set(saved["companies"]) == {"005930", "000660"}
    assert saved["companies"]["005930"]["name"] == "삼성전자"
    assert saved["unmapped"] == ["069500"]
    # 두 번째 호출은 첫 호출에서 빠진 회사만.
    assert calls[1][0] == ("00164779",)
    assert "2/2" in result


def test_이번에_못_받은_종목은_이전_저장본을_유지한다(monkeypatch):
    from app import catalog, tasks

    old = {"000660": {"bsnsYear": "2023", "accounts": {}}}
    fake = _FakeStore(
        snapshots={
            catalog.SNAP_DART_CORP_CODES: {"codes": {"005930": {"corpCode": "00126380", "name": "삼성전자"}}},
            catalog.SNAP_DART_FUNDAMENTALS: {"companies": old},
        },
        codes=["005930"],
    )
    monkeypatch.setattr(tasks.korea_public, "store", fake)
    monkeypatch.setattr(tasks.dart_service, "fetch_accounts", lambda codes, year: [_row("005930", "CFS", "자본총계", "10")])

    tasks.task_dart_fundamentals()

    assert set(fake.snapshots[catalog.SNAP_DART_FUNDAMENTALS]["companies"]) == {"005930", "000660"}


def test_키가_없으면_EmptyResult(monkeypatch):
    from app import tasks

    fake = _FakeStore(codes=["005930"])
    monkeypatch.setattr(tasks.korea_public, "store", fake)

    def missing():
        raise publicapi.MissingKey("x")

    monkeypatch.setattr(tasks.dart_service, "fetch_corp_codes", missing)
    with pytest.raises(tasks.EmptyResult, match="DART_API_KEY"):
        tasks.task_dart_fundamentals()


# ---- QA-077: 최신 연도 호출이 일시 실패하면 저장된 최신 연도 재무를 한 해 전 자료로 덮던 문제 ----------------
def _year_row(stock, year, equity):
    return {**_row(stock, "CFS", "자본총계", equity), "bsns_year": str(year)}


def _two_company_store(stored):
    from app import catalog

    return _FakeStore(
        snapshots={
            catalog.SNAP_DART_CORP_CODES: {"codes": {
                "005930": {"corpCode": "00126380", "name": "삼성전자"},
                "000660": {"corpCode": "00164779", "name": "SK하이닉스"},
            }},
            catalog.SNAP_DART_FUNDAMENTALS: {"companies": stored},
        },
        codes=["005930", "000660"],
    )


def test_QA077_최신_연도_묶음_호출이_실패하면_전년도로_다시_받지_않고_저장본을_유지한다(monkeypatch):
    """
    '한 해 전으로'는 최신 연도 호출이 **성공했는데** 그 회사 행이 없을 때만입니다. 호출 자체가 실패한 묶음
    (시간 초과·5xx)까지 전년도로 다시 받으면, 저장된 최신 연도 재무가 한 해 전 자료로 덮여 PER·PBR이 후퇴합니다.
    """
    from app import catalog, tasks

    latest = tasks._latest_annual_year(__import__("datetime").datetime.now(tasks.KST).date())
    fake = _two_company_store({"005930": {"bsnsYear": str(latest), "fsDiv": "CFS",
                                          "accounts": {"자본총계": {"current": 100.0}}}})
    monkeypatch.setattr(tasks.korea_public, "store", fake)
    monkeypatch.setattr(tasks.dart_service, "BATCH", 1)   # 회사마다 한 묶음
    calls = []

    def fetch(corp_codes, year):
        calls.append((tuple(corp_codes), year))
        if corp_codes == ["00126380"] and year == latest:
            raise publicapi.PublicApiError("HTTP 503 — JSON이 아닌 응답")
        if corp_codes == ["00126380"]:
            return [_year_row("005930", year, "90")]
        return [] if year == latest else [_year_row("000660", year, "5")]   # SK하이닉스는 최신 보고서가 아직 없음

    monkeypatch.setattr(tasks.dart_service, "fetch_accounts", fetch)
    result = tasks.task_dart_fundamentals()

    companies = fake.snapshots[catalog.SNAP_DART_FUNDAMENTALS]["companies"]
    assert (("00126380",), latest - 1) not in calls
    assert companies["005930"]["bsnsYear"] == str(latest)
    assert companies["005930"]["accounts"]["자본총계"]["current"] == 100.0
    assert companies["000660"]["bsnsYear"] == str(latest - 1)
    # 결과 문구는 실제로 받은 연도를 적습니다(전부 최신 연도인 것처럼 적지 않음).
    assert f"{latest - 1}년" in result


def test_QA077_저장본보다_이른_사업연도로는_덮지_않는다(monkeypatch):
    """최신 연도 응답에 그 회사 행이 빠진 날(정정·철회 공시 등)에도 저장된 최신 연도 재무를 한 해 전 자료로 바꾸지 않습니다."""
    from app import catalog, tasks

    latest = tasks._latest_annual_year(__import__("datetime").datetime.now(tasks.KST).date())
    fake = _two_company_store({"005930": {"bsnsYear": str(latest), "fsDiv": "CFS",
                                          "accounts": {"자본총계": {"current": 100.0}}}})
    monkeypatch.setattr(tasks.korea_public, "store", fake)
    monkeypatch.setattr(tasks.dart_service, "fetch_accounts", lambda codes, year: (
        [_year_row("000660", year, "7")] if year == latest else [_year_row("005930", year, "90")]))

    tasks.task_dart_fundamentals()

    companies = fake.snapshots[catalog.SNAP_DART_FUNDAMENTALS]["companies"]
    assert companies["005930"]["bsnsYear"] == str(latest)
    assert companies["005930"]["accounts"]["자본총계"]["current"] == 100.0
    assert companies["000660"]["bsnsYear"] == str(latest)


# ---- B8: 재무 대상 순서 — 한국 책 수집 범위 먼저, 레이더 종목 뒤에 (v2 2단계 명세 §4-5) ----------------
def _days_ago(n):
    from datetime import datetime, timedelta

    from app import tasks
    return (datetime.now(tasks.KST).date() - timedelta(days=n)).isoformat()


def _kr_store(**kwargs):
    """최신 U(순위가 코드 순과 다르게) + 한 달 전 U(끈적 목록 — 지금 U 밖 888880·111110)."""
    return _FakeStore(universe={
        _days_ago(30): [{"code": "888880", "rank": 1}, {"code": "222220", "rank": 2}, {"code": "111110", "rank": 3}],
        _days_ago(1): [{"code": "333330", "rank": 2}, {"code": "222220", "rank": 1}],
    }, **kwargs)


def _use(monkeypatch, fake):
    from app import tasks
    monkeypatch.setattr(tasks.korea_public, "store", fake)
    monkeypatch.setattr(tasks.kr_paper, "store", fake)


def test_B8_재무_대상은_한국_범위_U_순위_끈적_목록_다음에_레이더_종목(monkeypatch):
    from app import catalog, tasks

    scanner = catalog.snap_radar_scanner(*tasks.RADAR_COMBINATIONS[0])
    fake = _kr_store(codes=["444440", "333330", "069500"],   # 레이더 기록: 한국 범위와 겹치는 333330·ETF 069500
                     snapshots={scanner: {"rows": [{"code": "555550"}, {"code": "444440"}]}})
    _use(monkeypatch, fake)

    codes, kr_count = tasks._dart_universe()

    # U 순위(222220·333330) → 끈적 목록 코드 순(111110·888880) → 레이더(겹친 333330은 한 번만, 레이더의 ETF는 예전처럼 남음)
    assert codes == ["222220", "333330", "111110", "888880", "444440", "069500", "555550"]
    assert kr_count == 4
    assert "153130" not in codes   # 수집 범위의 ETF 2는 DART 대상이 아니라 넣지 않음


def test_B8_한국_범위는_상한까지만이고_레이더_몫을_밀어내지_않는다(monkeypatch):
    from app import tasks

    fake = _kr_store(codes=[f"9{i:04d}0" for i in range(5)])
    _use(monkeypatch, fake)
    monkeypatch.setattr(tasks.korea_public, "DART_KR_SCOPE_LIMIT", 2)
    monkeypatch.setattr(tasks.korea_public, "DART_UNIVERSE_LIMIT", 3)

    codes, kr_count = tasks._dart_universe()

    assert codes == ["222220", "333330", "900000", "900010", "900020"]
    assert kr_count == 2


def test_B8_유니버스_저장본이_없으면_레이더_종목만이라_예전과_같다(monkeypatch):
    from app import tasks

    fake = _FakeStore(codes=["005930", "000660"])
    _use(monkeypatch, fake)

    assert tasks._dart_universe() == (["005930", "000660"], 0)


def test_B8_예산이_모자라면_한국_범위부터_받는다(monkeypatch):
    from app import catalog, tasks

    corp = {code: {"corpCode": f"0{code}0", "name": code} for code in ("222220", "333330", "111110", "888880", "444440")}
    fake = _kr_store(codes=["444440"], snapshots={catalog.SNAP_DART_CORP_CODES: {"codes": corp}})
    _use(monkeypatch, fake)
    monkeypatch.setattr(tasks.dart_service, "BATCH", 2)
    monkeypatch.setattr(tasks.korea_public, "DART_CALL_BUDGET", 2)
    calls = []

    def fetch(corp_codes, year):
        calls.append(tuple(corp_codes))
        stock = {v["corpCode"]: k for k, v in corp.items()}
        return [{**_row(stock[c], "CFS", "자본총계", "10"), "bsns_year": str(year)} for c in corp_codes]

    monkeypatch.setattr(tasks.dart_service, "fetch_accounts", fetch)
    result = tasks.task_dart_fundamentals()

    assert calls == [("02222200", "03333300"), ("01111100", "08888800")]   # 레이더 444440은 예산 밖
    saved = fake.snapshots[catalog.SNAP_DART_FUNDAMENTALS]
    assert set(saved["companies"]) == {"222220", "333330", "111110", "888880"}
    assert saved["universe"] == 5 and saved["krScope"] == 4
    assert "한국 책 범위 4 먼저" in result and "호출 예산 소진" in result


def test_B8_두_상한의_합은_두_연도를_다_물어도_호출_예산_안():
    """최신 연도 한 바퀴 + 행이 없던 회사의 한 해 전 한 바퀴 — 둘 다 끝까지 물어도 예산이 남아 뒤쪽 레이더 종목이 늘 받힌다."""
    import math

    from app import tasks
    from app.services import dart as dart_service

    per_year = math.ceil((tasks.DART_KR_SCOPE_LIMIT + tasks.DART_UNIVERSE_LIMIT) / dart_service.BATCH)
    assert 2 * per_year <= tasks.DART_CALL_BUDGET
