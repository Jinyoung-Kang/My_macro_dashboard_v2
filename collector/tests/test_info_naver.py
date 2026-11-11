"""
tests/test_info_naver.py
정보 수집(ADR 0035) — 네이버 투자자별 매매동향·매매상위 스냅샷.

고정하는 규칙
  1. 매매동향은 화면과 같은 묶음(외국인=9000+9001, 투신=3000+3100, 연기금=6000+7000, 기관계=여섯 칸의 합)이고, 응답에 없는 구분은 null입니다.
  2. 장중 추정 순위의 금액 칸("0")은 모르는 값(null)이지 0원이 아닙니다.
  3. 한 부분을 받지 못하면 직전 저장본의 그 부분을 이어받고 isStale을 답니다. 모두 형식이 다르면 '형식 바뀜'입니다.
  4. 거부되면 그대로 올립니다(저장본을 덮지 않음).

표본은 구조만 흉내 낸 합성 JSON입니다(실제 응답 원문 아님). 네트워크를 쓰지 않습니다.
"""
from __future__ import annotations

import json
import random
from datetime import datetime, timedelta, timezone

import pytest

from app import catalog
from app.fetch import ladder, state
from app.services import info_naver
from app.services.info_text import ShapeError
from app.tasks import info as info_tasks

NOW = datetime(2026, 11, 11, 7, 0, tzinfo=timezone.utc)


def _amount(code: str, won: int) -> dict:
    return {"investorGubun": code, "diffValue": str(won), "sellQuant": "1", "sellPrice": "1", "buyQuant": "1", "buyPrice": "1"}


def _trend(*, drop: str | None = None) -> dict:
    codes = {"9001": -1_000_000_000, "9000": 101_000_000_000, "8000": -90_000_000_000, "7100": 5_000_000_000,
             "7000": 1_000_000_000, "6000": 9_000_000_000, "5000": 0, "4000": 2_000_000_000, "3100": 500_000_000,
             "3000": 1_500_000_000, "2000": 3_000_000_000, "1000": -4_000_000_000}
    amounts = [_amount(code, won) for code, won in codes.items() if code != drop]
    return {"content": [{"bizdate": "20261110", "time": "", "netAmounts": amounts}], "totalElements": 1}


def _ranking(*, estimated: bool) -> dict:
    row = {"itemcode": "000001", "itemname": "가나다", "bizdateFrom": "20261111", "bizdateTo": "20261111",
           "accTradeVolume": "-873324" if estimated else "898837", "accTradeAmount": "0" if estimated else "166159457000",
           "nowPrice": "7210", "prevChangeRate": "-1.1", "estimated": True if estimated else None,
           "toRankingAt": "2026-11-11T16:44:10+09:00" if estimated else None}
    return {"sections": {"buyRankList": [row], "sellRankList": [dict(row, itemcode="000002")]}}


class FakeFetch:
    def __init__(self, answer):
        self.answer = answer
        self.calls: list[dict] = []

    def __call__(self, url, *, expect=None, params=None, headers=None):
        self.calls.append({"url": url, "params": dict(params), "headers": headers, "expect": expect})
        part = "trend" if url.endswith("/daily") else params["investorType"]
        answer = self.answer(part, params["marketType"])
        if isinstance(answer, Exception):
            raise answer
        return ladder.Fetched(url=url, status=200, content_type="application/json", body=json.dumps(answer).encode(),
                              tier="impersonate", final_url=url)


# ==============================================================================
# 1·2. 파서
# ==============================================================================
def test_매매동향은_화면과_같이_묶고_억_원으로():
    row = info_naver.parse_trend(_trend())[0]

    assert row["date"] == "2026-11-10"
    assert row["foreign"] == 1000.0          # 9000 + 9001
    assert row["trust"] == 20.0              # 3000 + 3100
    assert row["pension"] == 100.0           # 6000 + 7000
    assert row["otherFinancial"] == 0.0, "응답이 0이면 0입니다(거래 없음)"
    assert row["institution"] == round(-40 + 30 + 20 + 20 + 0 + 100, 1)
    assert row["individual"] == -900.0 and row["otherCorp"] == 50.0


def test_구분이_빠지면_그_칸과_기관계는_모르는_값():
    row = info_naver.parse_trend(_trend(drop="2000"))[0]

    assert row["insurance"] is None and row["institution"] is None
    assert row["foreign"] == 1000.0


def test_장중_추정_순위의_금액은_모르는_값이고_주식_수만_있다():
    parsed = info_naver.parse_rankings(_ranking(estimated=True))

    assert parsed["estimated"] is True and parsed["rankedAt"] == "2026-11-11T16:44:10+09:00"
    assert parsed["buy"][0]["netAmountEok"] is None and parsed["buy"][0]["netVolume"] == -873324


def test_확정_순위는_금액을_억_원으로():
    parsed = info_naver.parse_rankings(_ranking(estimated=False))

    assert parsed["estimated"] is False
    assert parsed["buy"][0]["netAmountEok"] == 1661.6
    assert parsed["period"] == {"from": "2026-11-11", "to": "2026-11-11"}


@pytest.mark.parametrize("payload", [{}, {"sections": {}}, {"content": None}, []])
def test_모양이_다르면_형식_바뀜(payload):
    with pytest.raises(ShapeError):
        info_naver.parse_rankings(payload)
    with pytest.raises(ShapeError):
        info_naver.parse_trend(payload)


# ==============================================================================
# 3·4. 모으기
# ==============================================================================
def test_여섯_부분을_무작위_순서로_받고_화면의_문맥을_보낸다():
    fetch = FakeFetch(lambda part, market: _trend() if part == "trend" else _ranking(estimated=False))

    snap = info_naver.collect(None, fetch=fetch, now=NOW, rng=random.Random(3))

    assert len(fetch.calls) == 6 and snap["failed"] == []
    assert {c["params"].get("investorType", "trend") for c in fetch.calls} == {"trend", "FOREIGNER", "ORGANIZATION"}
    assert all(c["expect"] == "json" and c["headers"]["Referer"].startswith("https://stock.naver.com/") for c in fetch.calls)
    order = [(c["params"].get("investorType", "trend"), c["params"]["marketType"]) for c in fetch.calls]
    other = FakeFetch(lambda part, market: _trend() if part == "trend" else _ranking(estimated=False))
    info_naver.collect(None, fetch=other, now=NOW, rng=random.Random(11))
    assert order != [(c["params"].get("investorType", "trend"), c["params"]["marketType"]) for c in other.calls]
    assert snap["trend"]["KOSPI"]["rows"][0]["date"] == "2026-11-10"
    assert snap["rankings"]["ORGANIZATION"]["KOSDAQ"]["buy"][0]["code"] == "000001"


def test_받지_못한_부분은_직전_값을_이어받고_표시한다():
    previous = {"trend": {"KOSDAQ": {"rows": [{"date": "2026-11-07"}]}},
                "rankings": {"FOREIGNER": {"KOSPI": {"buy": [], "sell": [], "estimated": False}}}}

    def answer(part, market):
        if (part, market) in {("trend", "KOSDAQ"), ("FOREIGNER", "KOSPI")}:
            return ladder.FetchFailed("HTTP 503")
        return _trend() if part == "trend" else _ranking(estimated=True)

    snap = info_naver.collect(previous, fetch=FakeFetch(answer), now=NOW, rng=random.Random(1))

    assert sorted(snap["failed"]) == ["FOREIGNER.KOSPI", "trend.KOSDAQ"]
    assert snap["trend"]["KOSDAQ"] == {"rows": [{"date": "2026-11-07"}], "isStale": True}
    assert snap["rankings"]["FOREIGNER"]["KOSPI"]["isStale"] is True
    assert "isStale" not in snap["trend"]["KOSPI"]


def test_모두_형식이_다르면_형식_바뀜():
    with pytest.raises(ShapeError):
        info_naver.collect(None, fetch=FakeFetch(lambda part, market: {"unexpected": True}), now=NOW)


def test_거부되면_그대로_올린다():
    closed = state.Closed("stock.naver.com", "HTTP 403(계층 impersonate)", NOW + timedelta(hours=1), False)

    with pytest.raises(ladder.FetchRejected):
        info_naver.collect(None, fetch=FakeFetch(lambda part, market: ladder.FetchRejected(closed)), now=NOW)


# ==============================================================================
# 5. 출처 상태 (QA-391) — 일부만 받지 못해도 '정상'으로 남지 않습니다
# ==============================================================================
def _run_naver_task(monkeypatch, answer):
    """네이버 태스크를 가짜 받기로 한 번 돌립니다(일정은 '때가 됨'으로 당겨 둠) → detail."""
    real = info_naver.collect
    monkeypatch.setattr(info_naver, "collect",
                        lambda previous, **kwargs: real(previous, fetch=FakeFetch(answer), now=NOW, rng=random.Random(1), **kwargs))
    state.set_due_at(info_tasks.NAVER_TASK, state._utcnow() - timedelta(minutes=1))
    return info_tasks.task_info_naver_flows()


def test_QA391_매매동향만_받지_못하면_저장은_하고_출처_상태는_failed(store, monkeypatch):
    def answer(part, market):
        return ladder.FetchFailed("stock.naver.com HTTP 404") if part == "trend" else _ranking(estimated=False)

    detail = _run_naver_task(monkeypatch, answer)

    snap = store.read_snapshot(catalog.SNAP_INFO_NAVER_FLOWS).payload
    assert sorted(snap["failed"]) == ["trend.KOSDAQ", "trend.KOSPI"] and snap["rankings"]["FOREIGNER"]["KOSPI"]["buy"], "받은 부분은 저장"
    row = store.source_state(info_tasks.NAVER_TASK)
    assert row["status"] == "failed" and "trend.KOSDAQ" in row["reason"] and "trend.KOSPI" in row["reason"]
    assert row["last_ok_at"] is None, "마지막 성공 시각은 전부 받은 실행에서만"
    assert "일부 받지 못함" in detail


def test_QA391_전부_받으면_ok(store, monkeypatch):
    _run_naver_task(monkeypatch, lambda part, market: _trend() if part == "trend" else _ranking(estimated=False))

    row = store.source_state(info_tasks.NAVER_TASK)
    assert row["status"] == "ok" and row["last_ok_at"] is not None


def test_QA391_일부의_형식이_다르면_format이_먼저(store, monkeypatch):
    def answer(part, market):
        if part == "trend":
            return {"unexpected": True} if market == "KOSPI" else ladder.FetchFailed("stock.naver.com HTTP 503")
        return _ranking(estimated=False)

    _run_naver_task(monkeypatch, answer)

    assert store.source_state(info_tasks.NAVER_TASK)["status"] == "format"


def test_QA391_예산으로_보내지_않은_부분은_받지_못함으로_세지_않는다(store, monkeypatch):
    sent = {"n": 0}

    def answer(part, market):
        sent["n"] += 1
        if sent["n"] > 4:
            return ladder.FetchSkipped("stock.naver.com 오늘 요청 예산(250건)을 다 써서 보내지 않음")
        return _trend() if part == "trend" else _ranking(estimated=False)

    unsent: list[str] = []
    snap = info_naver.collect(None, fetch=FakeFetch(answer), now=NOW, rng=random.Random(1), unsent=unsent)
    assert len(snap["failed"]) == 2 and sorted(unsent) == sorted(snap["failed"])

    sent["n"] = 0
    detail = _run_naver_task(monkeypatch, answer)
    assert store.source_state(info_tasks.NAVER_TASK)["status"] == "ok" and "일부 받지 못함" not in detail
