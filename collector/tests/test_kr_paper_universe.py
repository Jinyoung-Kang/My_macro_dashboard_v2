"""
tests/test_kr_paper_universe.py
🧪 한국 책 유니버스 U와 수집 범위(v2 2단계 B4·K3, 명세 §4-5) — 저장 쪽은 PostgreSQL 필요.

고정하는 규칙
  1. U = 금융위 최신 기준일 B(< 오늘)의 코스피 시가총액 상위 100 보통주. 우선주(코드 끝자리·이름 '우'·'우B'·'우C')·스팩·리츠
     ('메리츠'의 '리츠'는 아님)·거래정지(그날 거래량 0)·DART 고유번호 없음은 뺀다 — 실제 이름으로 잠근다(추정 규칙).
  2. 같은 기준일·같은 규칙 판이면 다시 쓰지 않고, 기준일이 바뀌면 그날 U를 통째로 쓴다. 외부 호출 없음.
  3. 금융위 저장본·DART 고유번호 표가 없으면 EmptyResult — 저장본을 그대로 둔다.
  4. 수집 범위 = ETF 2 → 최신 U 순위 → 끈적 목록(보존 기간 안 이력의 다른 종목, 코드 순).
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app import catalog, tasks
from app.tasks import kr_paper
from app.tasks.base import KST

# 2026-10-23 금융위 코스피 실제 이름·코드(시총·거래량은 시험용 값). 우선주 셋과 리츠 둘은 빠지고, '메리츠'·투융자회사는 남는다.
REAL_NAMES = [
    ("005930", "삼성전자", True),
    ("005935", "삼성전자우", False),        # 우선주 — 코드 끝자리 5·이름 '우'
    ("005387", "현대차2우B", False),        # 우선주 — '우B'
    ("005385", "현대차우", False),
    ("138040", "메리츠금융지주", True),     # '메리츠'의 '리츠'는 리츠가 아님
    ("088260", "이리츠코크렙", False),      # 리츠(이름 가운데 '리츠')
    ("395400", "SK리츠", False),
    ("088980", "맥쿼리인프라", True),       # 투융자회사 — 명세의 제외 규칙에 없음
]


def _row(code, name, cap, *, market="KOSPI", volume=1000.0):
    return {"code": code, "name": name, "market": market, "close": 1000.0, "volume": volume,
            "listedShares": 1_000_000.0, "marketCap": cap, "basDt": "20261023"}


def _dart(codes):
    return {code: {"corpCode": f"C{code}", "name": code} for code in codes}


def test_실제_이름으로_우선주_리츠_규칙을_잠근다():
    rows = [_row(code, name, 1e12 - i) for i, (code, name, _kept) in enumerate(REAL_NAMES)]
    members, excluded = kr_paper.select_universe(rows, _dart(code for code, *_ in REAL_NAMES))

    assert [m["code"] for m in members] == [code for code, _name, kept in REAL_NAMES if kept]
    assert excluded == {"우선주": 3, "리츠": 2}


def test_스팩_거래정지_DART_없음과_코스피_밖은_빠진다():
    rows = [
        _row("100000", "보통주갑", 5e12),
        _row("200000", "미래에셋비전스팩1호", 4e12),
        _row("300000", "정지된회사", 3e12, volume=0.0),
        _row("400000", "거래량모름", 2.5e12, volume=None),
        _row("500000", "DART없는회사", 2e12),
        _row("600000", "코스닥회사", 9e12, market="KOSDAQ"),
        _row("700000", "시총모름", None),
    ]
    members, excluded = kr_paper.select_universe(rows, _dart(["100000", "200000", "300000", "400000", "600000", "700000"]))

    assert [m["code"] for m in members] == ["100000"]
    assert excluded == {"스팩": 1, "거래정지": 2, "DART 없음": 1, "시총 없음": 1}


def test_시총_순서_같으면_코드_순_100종목까지_순위와_규칙_판():
    rows = [_row(f"{i:05d}0", f"회사{i}", float(1000 - i)) for i in range(120)]
    rows.append(_row("9999A0", "같은시총", float(1000 - 5)))   # 영문 섞인 새 코드도 보통주(끝자리 0)
    members, _ = kr_paper.select_universe(rows, _dart(r["code"] for r in rows))

    assert len(members) == kr_paper.KR_UNIVERSE_SIZE == 100
    assert [m["rank"] for m in members] == list(range(1, 101))
    assert [m["code"] for m in members[4:7]] == ["000040", "000050", "9999A0"]
    assert members[0] == {"code": "000000", "name": "회사0", "rank": 1, "marketCap": 1000.0, "listedShares": 1_000_000.0,
                          "close": 1000.0, "rule": kr_paper.KR_UNIVERSE_RULE}


# ------------------------------------------------------------------ 저장 (PostgreSQL)
def _days_ago(n: int) -> str:
    return (datetime.now(KST).date() - timedelta(days=n)).isoformat()


def _seed(store, day: str, rows, dart_codes):
    store.put_observations(catalog.OBS_FSC_PRICE, day, rows, entity_key="code")
    store.put_snapshot(catalog.SNAP_DART_CORP_CODES, {"codes": _dart(dart_codes), "count": len(dart_codes)})


def test_최신_기준일의_U를_쓰고_다시_돌면_최신_상태(store):
    old, latest = _days_ago(4), _days_ago(1)
    _seed(store, old, [_row("111110", "옛회사", 1e12)], ["111110", "222220", "333330"])
    _seed(store, latest, [_row("222220", "큰회사", 2e12), _row("333330", "작은회사", 1e12),
                          _row("333335", "작은회사우", 9e11)], ["111110", "222220", "333330"])

    detail = tasks.task_kr_paper_universe()

    assert detail == f"기준일 {latest} 코스피 3종목 → 2종목 — 100종목에 못 미침 (제외 우선주 1)"
    saved = store.read_observations(catalog.OBS_KR_PAPER_UNIVERSE, obs_date=latest)
    assert [(r["code"], r["rank"]) for r in saved] == [("222220", 1), ("333330", 2)]
    assert store.read_observations(catalog.OBS_KR_PAPER_UNIVERSE, obs_date=old) == []
    assert tasks.task_kr_paper_universe() == f"최신 상태 (기준일 {latest}, 2종목)"


def test_오늘_날짜의_금융위_행은_기준일로_쓰지_않는다(store):
    """금융위는 D를 D+1 13시 뒤에 줍니다 — 오늘 날짜 행이 있다면 시계가 틀린 것이라 B는 그 앞입니다(B < 오늘)."""
    yesterday, today = _days_ago(1), _days_ago(0)
    _seed(store, yesterday, [_row("222220", "어제회사", 2e12)], ["222220", "999990"])
    _seed(store, today, [_row("999990", "오늘회사", 9e12)], ["222220", "999990"])

    tasks.task_kr_paper_universe()

    assert store.latest_observation_date(catalog.OBS_KR_PAPER_UNIVERSE) == yesterday


def test_규칙_판이_바뀌면_같은_기준일도_통째로_다시_쓴다(store, monkeypatch):
    day = _days_ago(1)
    _seed(store, day, [_row("222220", "큰회사", 2e12), _row("333330", "작은회사", 1e12)], ["222220", "333330"])
    tasks.task_kr_paper_universe()

    monkeypatch.setattr(kr_paper, "KR_UNIVERSE_RULE", "test/v2")
    monkeypatch.setattr(kr_paper, "KR_UNIVERSE_SIZE", 1)
    detail = tasks.task_kr_paper_universe()

    saved = store.read_observations(catalog.OBS_KR_PAPER_UNIVERSE, obs_date=day)
    assert [(r["code"], r["rule"]) for r in saved] == [("222220", "test/v2")]   # 밀려난 333330이 남지 않음
    assert detail.startswith(f"기준일 {day} 코스피 2종목 → 1종목")


def test_금융위_저장본이_없으면_EmptyResult(store):
    with pytest.raises(tasks.EmptyResult) as exc:
        tasks.task_kr_paper_universe()
    assert "fsc_prices" in str(exc.value)


def test_DART_고유번호_표가_없으면_EmptyResult이고_저장본을_지킨다(store):
    day = _days_ago(2)
    before = [{"code": "222220", "name": "큰회사", "rank": 1, "rule": kr_paper.KR_UNIVERSE_RULE}]
    store.put_observations(catalog.OBS_KR_PAPER_UNIVERSE, day, before, entity_key="code")
    store.put_observations(catalog.OBS_FSC_PRICE, _days_ago(1), [_row("333330", "새회사", 1e12)], entity_key="code")

    with pytest.raises(tasks.EmptyResult) as exc:
        tasks.task_kr_paper_universe()

    assert "DART 고유번호 표" in str(exc.value)
    assert [r["code"] for r in store.read_observations(catalog.OBS_KR_PAPER_UNIVERSE)] == ["222220"]


def test_보존_기간이_지난_유니버스_행은_지운다(store):
    ancient = _days_ago(kr_paper.KR_UNIVERSE_RETENTION_DAYS + 5)
    store.put_observations(catalog.OBS_KR_PAPER_UNIVERSE, ancient, [{"code": "777770", "rank": 1}], entity_key="code")
    _seed(store, _days_ago(1), [_row("222220", "큰회사", 2e12)], ["222220"])

    tasks.task_kr_paper_universe()

    assert store.read_observations(catalog.OBS_KR_PAPER_UNIVERSE, obs_date=ancient) == []


def test_수집_범위는_ETF_U_순위_끈적_목록_순이고_중복이_없다(store):
    store.put_observations(catalog.OBS_KR_PAPER_UNIVERSE, _days_ago(30),
                           [{"code": "888880", "rank": 1}, {"code": "222220", "rank": 2}, {"code": "069500", "rank": 3}],
                           entity_key="code")
    store.put_observations(catalog.OBS_KR_PAPER_UNIVERSE, _days_ago(1),
                           [{"code": "333330", "rank": 2}, {"code": "222220", "rank": 1}], entity_key="code")

    codes, basis = tasks.kr_scope()

    assert codes == ["069500", "153130", "222220", "333330", "888880"]
    assert basis == _days_ago(1)


def test_유니버스_저장본이_없으면_범위는_ETF_둘뿐(store):
    assert tasks.kr_scope() == (["069500", "153130"], None)


def test_slow에서_토스_태스크_뒤에_돌고_태스크는_31개():
    task = tasks.TASKS_BY_NAME["kr_paper_universe"]
    assert task.speed == "slow" and task.run is kr_paper.task_kr_paper_universe
    names = [t.name for t in tasks.ALL_TASKS]
    assert names.index("kr_paper_universe") == names.index("toss_radar_universe") + 1
    assert len(tasks.ALL_TASKS) == len(tasks.TASKS_BY_NAME) == 31
