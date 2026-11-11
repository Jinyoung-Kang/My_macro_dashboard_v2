"""
tests/test_info_wire.py
정보 수집 3(ADR 0037) — Financial Juice 속보 RSS.

고정하는 규칙
  1. 제목 앞의 출처 꼬리표("FinancialJuice:")를 떼고, 제목·링크·시각만 넣습니다(kind headline, 본문 없음 — 없는 본문을 만들지 않음).
  2. 이미 받은 줄은 다시 넣지 않고, 이틀보다 오래된 줄은 넣지 않습니다.
  3. 피드에서 줄을 읽지 못하면 '형식 바뀜'입니다.
  4. 전에 받은 적이 있는데 겹치는 줄이 하나도 없으면 '누락 가능'을 실행 기록에 적습니다(첫 수집은 아님).
  5. 호스트가 정책 표에 있고 계층 1만 씁니다(XML 피드 — 실제 브라우저로 올리지 않음). 태스크는 polite입니다.

표본은 구조만 흉내 낸 합성 피드입니다(실제 응답 원문 아님). 네트워크를 쓰지 않습니다.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

import pytest

from app import http
from app.fetch import ladder, policy
from app.services import info_text, info_wire
from app.services.info_text import ShapeError
from app.tasks import info as info_tasks, registry

NOW = datetime(2026, 11, 11, 12, 30, tzinfo=timezone.utc)


def _link(n: int) -> str:
    return f"https://www.financialjuice.com/News/{9000000 + n}/Sample-headline-{n}.aspx?xy=rss"


def _item(n: int, *, hours_ago: float = 0.0, title: str | None = None) -> str:
    when = format_datetime(NOW - timedelta(hours=hours_ago))
    text = title if title is not None else f"FinancialJuice: Sample headline {n} $TICK"
    return (f"<item><title>{text}</title><link>{_link(n)}</link><guid isPermaLink=\"false\">{9000000 + n}</guid>"
            f"<pubDate>{when}</pubDate><description></description><author>FinancialJuice</author></item>")


def _feed(*items: str) -> bytes:
    return ('<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>FinancialJuice</title>'
            + "".join(items) + "</channel></rss>").encode("utf-8")


class FakeFetch:
    def __init__(self, body: bytes | Exception):
        self.body = body
        self.calls: list[str] = []

    def __call__(self, url, **_):
        self.calls.append(url)
        if isinstance(self.body, Exception):
            raise self.body
        return ladder.Fetched(url=url, status=200, content_type="text/xml; charset=utf-8", body=self.body,
                              tier="impersonate", final_url=url)


def test_제목의_꼬리표를_떼고_제목_링크_시각만_넣는다(store):
    fetch = FakeFetch(_feed(_item(1), _item(2, hours_ago=1)))

    detail = info_wire.collect(fetch=fetch, now=NOW)

    assert fetch.calls == [info_wire.FEED_URL]
    row = store.info_item(info_text.item_id(_link(1)))
    assert row["title"] == "Sample headline 1 $TICK" and row["source"] == "wire.financialjuice" and row["kind"] == "headline"
    assert row["body"] is None and row["body_status"] == "none" and row["summary"] is None, "없는 본문·요약을 만들지 않습니다"
    assert row["published_at"] == NOW and row["url"] == _link(1) and row["fetch_tier"] == "impersonate"
    assert "속보 2건" in detail and "새로 넣음 2" in detail and "누락 가능" not in detail


def test_이미_받은_줄은_다시_넣지_않고_이틀보다_오래된_줄은_넣지_않는다(store):
    info_wire.collect(fetch=FakeFetch(_feed(_item(1))), now=NOW)

    detail = info_wire.collect(fetch=FakeFetch(_feed(_item(1), _item(2), _item(3, hours_ago=60))), now=NOW)

    assert "새로 넣음 1" in detail and "누락 가능" not in detail
    assert store.info_item(info_text.item_id(_link(2))) is not None
    assert store.info_item(info_text.item_id(_link(3))) is None


def test_겹치는_줄이_없으면_누락_가능을_적는다(store):
    info_wire.collect(fetch=FakeFetch(_feed(_item(1))), now=NOW)

    detail = info_wire.collect(fetch=FakeFetch(_feed(_item(2), _item(3))), now=NOW)

    assert "새로 넣음 2" in detail and "누락 가능" in detail


def test_피드가_아니거나_제목이_꼬리표뿐이면_형식_바뀜이다(store):
    with pytest.raises(ShapeError):
        info_wire.collect(fetch=FakeFetch(b"<html><body>Sorry</body></html>"), now=NOW)
    with pytest.raises(ShapeError):
        info_wire.collect(fetch=FakeFetch(_feed(_item(1, title="FinancialJuice:"))), now=NOW)


def test_거부는_그대로_올린다(store):
    from app.fetch import state

    closed = state.Closed(host="www.financialjuice.com", reason="HTTP 403(계층 impersonate)",
                          until=NOW + timedelta(hours=1), given_up=False)
    with pytest.raises(ladder.FetchRejected):
        info_wire.collect(fetch=FakeFetch(ladder.FetchRejected(closed)), now=NOW)


def test_호스트는_정책_표에_있고_계층_1만_쓰며_태스크는_polite다():
    rules = policy.policy_for(http.host_of(info_wire.FEED_URL))

    assert rules.tiers == (policy.TIER_IMPERSONATE,) and rules.daily_budget >= 60
    task = registry.TASKS_BY_NAME[info_wire.TASK]
    assert task.speed == "polite"
    row = next(row for row in info_tasks.cadences() if row["task"] == info_wire.TASK)
    # 하루 예산이 가장 잦은 간격으로 돌 때의 요청 수보다 커야 합니다(예산이 수집을 막지 않게).
    assert 24 * 60 / row["lowMinutes"] <= rules.daily_budget
