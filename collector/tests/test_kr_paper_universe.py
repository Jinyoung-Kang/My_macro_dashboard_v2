"""
tests/test_kr_paper_universe.py
🧪 한국 책 유니버스 U와 수집 범위(v2 2단계 B4·K3, 명세 §4-5) — 저장 쪽은 PostgreSQL 필요.

고정하는 규칙
  1. U = 금융위 최신 기준일 B(< 오늘)의 코스피 시가총액 상위 100 보통주. 우선주(코드 끝자리·이름 '우'·'우B'·'우C')·스팩·리츠
     ('메리츠'의 '리츠'는 아님 · 이름에 '리츠'가 없는 맵스리얼티는 코드 표 — 사용자 결정 2026-10-28)·투융자회사(코드 표 — 사용자 결정
     2026-10-27)·거래정지(그날 거래량 0)·DART 고유번호 없음은 뺀다 — 실제 이름으로 잠근다(추정 규칙).
  2. 같은 기준일·같은 규칙 판이면 다시 쓰지 않고, 기준일이 바뀌면 그날 U를 통째로 쓴다. 외부 호출 없음.
  3. 금융위 저장본·DART 고유번호 표가 없으면 EmptyResult — 저장본을 그대로 둔다.
  4. 수집 범위 = ETF 2 → 최신 U 순위 → 끈적 목록(보존 기간 안 이력의 다른 종목, 코드 순).
  5. 결과 문구는 저장된 paper.kr.quotes의 토스 securityType이 알려졌고 STOCK이 아닌 U 종목을 '확인 필요'로 보인다 — U는 바꾸지 않는다.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app import catalog, tasks
from app.tasks import kr_paper
from app.tasks.base import KST

# 2026-10-23 금융위 코스피 실제 이름·코드(시총·거래량은 시험용 값). 우선주 셋·리츠 셋·투융자회사 둘은 빠지고, '메리츠'는 남는다.
REAL_NAMES = [
    ("005930", "삼성전자", True),
    ("005935", "삼성전자우", False),        # 우선주 — 코드 끝자리 5·이름 '우'
    ("005387", "현대차2우B", False),        # 우선주 — '우B'
    ("005385", "현대차우", False),
    ("138040", "메리츠금융지주", True),     # '메리츠'의 '리츠'는 리츠가 아님
    ("088260", "이리츠코크렙", False),      # 리츠(이름 가운데 '리츠')
    ("395400", "SK리츠", False),
    ("094800", "맵스리얼티", False),        # 리츠 — 이름에 '리츠'가 없어 코드 표(사용자 결정 2026-10-28, 판 v3)
    ("088980", "맥쿼리인프라", False),      # 투융자회사 — 코드 표(사용자 결정 2026-10-27, 판 v2)
    ("415640", "KB발해인프라", False),      # 투융자회사 — 지금 U 밖(시총)이지만 같은 표로
    ("063570", "NICE인프라", True),         # 이름에 '인프라'가 든 보통 회사(실제는 코스닥 — 이름 규칙을 쓰지 않음을 잠금)
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
    assert excluded == {"우선주": 3, "리츠": 3, "투융자회사": 2}


def test_투융자회사가_빠지면_101위가_들어온다(monkeypatch):
    """2026-10-26 로컬 저장본에서 맥쿼리인프라는 v1 U의 92위였습니다 — 빠지면 그 아래가 한 칸씩 오르고 101번째가 100위로 듭니다."""
    rows = [_row(f"{i:05d}0", f"회사{i}", float(1000 - i)) for i in range(101)]
    rows.append(_row("088980", "맥쿼리인프라", 909.5))   # 시총으로 92번째(회사90 910 > 909.5 > 회사91 909)
    dart = _dart(r["code"] for r in rows)
    with monkeypatch.context() as m:
        m.setattr(kr_paper, "KR_UNIVERSE_EXCLUDED_CODES", {})      # v1 규칙(코드 표 없음)이었다면
        before, _ = kr_paper.select_universe(rows, dart)
    assert before[91]["code"] == "088980" and "000990" not in [r["code"] for r in before]

    members, excluded = kr_paper.select_universe(rows, dart)

    assert len(members) == 100
    assert "088980" not in [r["code"] for r in members]
    assert [r["code"] for r in members[90:92]] == ["000900", "000910"]   # 92위 자리를 회사91이 이음
    assert members[-1] == {"code": "000990", "name": "회사99", "rank": 100, "marketCap": 901.0, "listedShares": 1_000_000.0,
                           "close": 1000.0, "rule": "kospi-mcap-top100-common/v3"}
    assert excluded == {"투융자회사": 1}


def test_맵스리얼티는_이름_규칙이_아니라_코드_표로_리츠_사유():
    row = _row("094800", "맵스리얼티", 6.2e11)
    with pytest.MonkeyPatch.context() as m:
        m.setattr(kr_paper, "KR_UNIVERSE_EXCLUDED_CODES", {})      # 코드 표가 없었다면(v2까지) 이름으로는 걸리지 않음
        assert kr_paper.universe_exclusion(row, _dart(["094800"])) is None
    assert kr_paper.universe_exclusion(row, _dart(["094800"])) == "리츠"


def test_코드_표의_사유는_결과_문구의_사유_목록에_있다():
    assert kr_paper.KR_UNIVERSE_EXCLUDED_CODES == {"088980": ("투융자회사", "맥쿼리인프라"),
                                                  "415640": ("투융자회사", "KB발해인프라"),
                                                  "094800": ("리츠", "맵스리얼티")}
    assert kr_paper.KR_UNIVERSE_RULE == "kospi-mcap-top100-common/v3"
    assert {reason for reason, _name in kr_paper.KR_UNIVERSE_EXCLUDED_CODES.values()} <= set(kr_paper._EXCLUSIONS)


def test_우선주의_두_규칙은_하나씩_따로_걸러낸다():
    """
    실제 우선주 세 행은 코드 끝자리와 이름 끝('우'·'우B')이 함께 걸려 한 규칙만 남아도 빠집니다 — 각 규칙만 잡는 합성 행으로 따로
    잠급니다. 둘 다 DART 표에 넣어 DART 규칙이 대신 걸러 주지 않게 합니다.
    """
    rows = [
        _row("100000", "보통주갑", 5e12),
        _row("123450", "가상전자우C", 4e12),    # 코드 끝자리 0 — 이름('우C')만 잡음
        _row("12345K", "새코드회사", 3e12),     # 이름은 보통주 꼴 — 코드 끝자리(≠ '0')만 잡음
        _row("223450", "우리금융지주", 2e12),   # '우'로 시작하는 보통주 이름은 남음
    ]
    members, excluded = kr_paper.select_universe(rows, _dart(r["code"] for r in rows))

    assert [m["code"] for m in members] == ["100000", "223450"]
    assert excluded == {"우선주": 2}
    assert kr_paper.universe_exclusion(rows[1], _dart(["123450"])) == "우선주"
    assert kr_paper.universe_exclusion(rows[2], _dart(["12345K"])) == "우선주"


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


def test_v1_판으로_저장된_기준일은_투융자회사를_빼고_다시_쓴다(store):
    """판을 v2로 올린 까닭 — v1(투융자회사 포함)으로 저장된 최신 기준일이 '최신 상태'로 남지 않고 다시 계산됩니다."""
    day = _days_ago(1)
    v1 = [{"code": "222220", "name": "큰회사", "rank": 1, "rule": "kospi-mcap-top100-common/v1"},
          {"code": "088980", "name": "맥쿼리인프라", "rank": 2, "rule": "kospi-mcap-top100-common/v1"}]
    store.put_observations(catalog.OBS_KR_PAPER_UNIVERSE, day, v1, entity_key="code")
    _seed(store, day, [_row("222220", "큰회사", 3e12), _row("088980", "맥쿼리인프라", 2e12), _row("333330", "작은회사", 1e12)],
          ["222220", "088980", "333330"])

    detail = tasks.task_kr_paper_universe()

    saved = store.read_observations(catalog.OBS_KR_PAPER_UNIVERSE, obs_date=day)
    assert sorted((r["code"], r["rank"], r["rule"]) for r in saved) == [
        ("222220", 1, "kospi-mcap-top100-common/v3"), ("333330", 2, "kospi-mcap-top100-common/v3")]
    assert detail == f"기준일 {day} 코스피 3종목 → 2종목 — 100종목에 못 미침 (제외 투융자회사 1)"


def test_v2_판으로_저장된_기준일은_맵스리얼티를_빼고_다시_쓴다(store):
    """판을 v3로 올린 까닭 — v2(맵스리얼티 포함)로 저장된 최신 기준일이 '최신 상태'로 남지 않고 다시 계산됩니다."""
    day = _days_ago(1)
    v2 = [{"code": "222220", "name": "큰회사", "rank": 1, "rule": "kospi-mcap-top100-common/v2"},
          {"code": "094800", "name": "맵스리얼티", "rank": 2, "rule": "kospi-mcap-top100-common/v2"}]
    store.put_observations(catalog.OBS_KR_PAPER_UNIVERSE, day, v2, entity_key="code")
    _seed(store, day, [_row("222220", "큰회사", 3e12), _row("094800", "맵스리얼티", 2e12), _row("333330", "작은회사", 1e12)],
          ["222220", "094800", "333330"])

    detail = tasks.task_kr_paper_universe()

    saved = store.read_observations(catalog.OBS_KR_PAPER_UNIVERSE, obs_date=day)
    assert sorted((r["code"], r["rank"], r["rule"]) for r in saved) == [
        ("222220", 1, "kospi-mcap-top100-common/v3"), ("333330", 2, "kospi-mcap-top100-common/v3")]
    assert detail == f"기준일 {day} 코스피 3종목 → 2종목 — 100종목에 못 미침 (제외 리츠 1)"
    assert tasks.task_kr_paper_universe() == f"최신 상태 (기준일 {day}, 2종목)"


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


def test_slow에서_토스_태스크_뒤에_돌고_태스크는_35개():
    task = tasks.TASKS_BY_NAME["kr_paper_universe"]
    assert task.speed == "slow" and task.run is kr_paper.task_kr_paper_universe
    names = [t.name for t in tasks.ALL_TASKS]
    assert names.index("kr_paper_universe") == names.index("toss_radar_universe") + 1
    assert len(tasks.ALL_TASKS) == len(tasks.TASKS_BY_NAME) == 37  # 장중 평가 paper_live_us·paper_live_kr까지


# ------------------------------------------------------------------ 토스 유형 경고(결과 문구만 — U는 그대로)
def _quotes(entries: dict) -> dict:
    return {"contract": 1, "session": _days_ago(1), "codes": entries}


def test_토스_유형이_STOCK이_아닌_U_종목은_결과_문구에_확인_필요로_보이고_U는_그대로(store):
    day = _days_ago(1)
    _seed(store, day, [_row("222220", "큰회사", 3e12), _row("333330", "새리얼티", 2e12), _row("444440", "작은회사", 1e12),
                       _row("555550", "유형모름", 9e11), _row("666660", "항목없음", 8e11)],
          ["222220", "333330", "444440", "555550", "666660"])
    store.put_snapshot(catalog.SNAP_KR_PAPER_QUOTES, _quotes({
        "222220": {"securityType": "STOCK"},
        "333330": {"securityType": "REIT"},
        "444440": {"securityType": "INFRASTRUCTURE_FUND", "isStale": True},   # 이어 쓴 항목도 유형은 알려진 값
        "555550": {"securityType": None},
        "069500": {"securityType": "ETF"},                                     # U 밖(수집 범위의 ETF)은 보지 않음
    }))

    detail = tasks.task_kr_paper_universe()

    assert detail == (f"기준일 {day} 코스피 5종목 → 5종목 — 100종목에 못 미침"
                      " · 확인 필요 — 토스 유형이 STOCK이 아닌 U 종목 2: 333330 새리얼티(REIT), 444440 작은회사(INFRASTRUCTURE_FUND)"
                      " (U 계산에는 쓰지 않음 — 제외 코드 표에 더할지 확인)")
    saved = store.read_observations(catalog.OBS_KR_PAPER_UNIVERSE, obs_date=day)
    assert sorted(r["code"] for r in saved) == ["222220", "333330", "444440", "555550", "666660"]
    # 같은 기준일 다시 — '최신 상태'에도 같은 경고(관측치가 U보다 뒤에 돌아 새 구성원의 유형은 다음 실행에야 알기 때문)
    assert tasks.task_kr_paper_universe() == (
        f"최신 상태 (기준일 {day}, 5종목)"
        " · 확인 필요 — 토스 유형이 STOCK이 아닌 U 종목 2: 333330 새리얼티(REIT), 444440 작은회사(INFRASTRUCTURE_FUND)"
        " (U 계산에는 쓰지 않음 — 제외 코드 표에 더할지 확인)")


def test_최신_상태의_확인_필요_경고도_저장본_코드_순이_아니라_순위_순이다(store):
    day = _days_ago(1)
    # 코드 순서와 순위가 엇갈림 — 2위 444440, 3위 333330(저장본은 코드 순으로 읽힘). 이름에 '리츠'가 없어 U에 듦
    _seed(store, day, [_row("222220", "큰회사", 3e12), _row("444440", "둘째리얼티", 2e12), _row("333330", "셋째인프라", 1e12)],
          ["222220", "333330", "444440"])
    store.put_snapshot(catalog.SNAP_KR_PAPER_QUOTES, _quotes({
        "333330": {"securityType": "INFRASTRUCTURE_FUND"},
        "444440": {"securityType": "REIT"},
    }))
    tail = (" · 확인 필요 — 토스 유형이 STOCK이 아닌 U 종목 2: 444440 둘째리얼티(REIT), 333330 셋째인프라(INFRASTRUCTURE_FUND)"
            " (U 계산에는 쓰지 않음 — 제외 코드 표에 더할지 확인)")

    assert tasks.task_kr_paper_universe().endswith(tail)
    assert [r["code"] for r in store.read_observations(catalog.OBS_KR_PAPER_UNIVERSE, obs_date=day)] == \
        ["222220", "333330", "444440"]
    assert tasks.task_kr_paper_universe() == f"최신 상태 (기준일 {day}, 3종목)" + tail


def test_관측치_저장본이_없거나_유형이_STOCK이거나_모르면_경고가_없다(store):
    day = _days_ago(1)
    _seed(store, day, [_row("222220", "큰회사", 3e12), _row("333330", "작은회사", 1e12)], ["222220", "333330"])
    assert tasks.task_kr_paper_universe() == f"기준일 {day} 코스피 2종목 → 2종목 — 100종목에 못 미침"

    store.put_snapshot(catalog.SNAP_KR_PAPER_QUOTES, _quotes({"222220": {"securityType": "STOCK"},
                                                              "333330": {"securityType": ""}}))
    assert tasks.task_kr_paper_universe() == f"최신 상태 (기준일 {day}, 2종목)"
    store.put_snapshot(catalog.SNAP_KR_PAPER_QUOTES, {"contract": 1, "codes": ["망가진", "모양"]})
    assert tasks.task_kr_paper_universe() == f"최신 상태 (기준일 {day}, 2종목)"


def test_확인_필요_종목은_순위_순으로_열까지만_보인다(store):
    members = [{"code": f"{i:05d}0", "name": f"회사{i}", "rank": i} for i in range(1, 13)]
    store.put_snapshot(catalog.SNAP_KR_PAPER_QUOTES, _quotes({m["code"]: {"securityType": "REIT"} for m in members}))

    tail = kr_paper.security_type_warning(members)

    assert tail.startswith(" · 확인 필요 — 토스 유형이 STOCK이 아닌 U 종목 12: 000010 회사1(REIT), ")
    assert "000100 회사10(REIT)…" in tail and "000110" not in tail
