"""
app/services/info_wire.py
정보 수집 3(ADR 0037) — Financial Juice 속보 RSS. 한 줄짜리 속보(제목·링크·시각)만 있고 본문은 출처에도 없습니다.

[왜 이 출처인가]
  saveticker.com(운영 서버 IP를 사이트가 대역째 막아 보류 — ADR 0036 결정 9)이 속보의 원출처로 밝힌 곳 가운데 하나입니다. 차단을 돌아가지
  않고 원출처가 내놓은 RSS를 받습니다(2026-11-11 운영 서버에서 설명형 UA로 200·100건 확인, robots.txt 없음).

[받는 순서]
  1. 피드 하나(최근 100건 — 한산한 시간대에 약 11시간 분량). 차단 통과 계층(app/fetch)의 지연·하루 예산·물러남을 그대로 탑니다.
  2. 제목 앞의 "FinancialJuice:" 꼬리표를 떼고, 정규화한 주소의 id로 이미 받은 줄은 건너뜁니다. 이틀보다 오래된 줄은 넣지 않습니다.
  3. info_items에 kind 'headline'·본문 없음(body_status 'none')으로 넣습니다. 피드에 설명 글이 있으면 요약 칸에 둡니다(지금은 비어 옴).

[실패 규칙]
  - 피드에서 줄을 하나도 읽지 못하면 '형식 바뀜'(:class:`info_text.ShapeError`). 저장된 줄은 그대로입니다.
  - 받은 줄이 모두 처음 보는 것이면(전에 받은 적이 있는데 겹치는 줄이 없음) 그 사이 줄을 놓쳤을 수 있어 실행 기록에 '누락 가능'을 적습니다.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Callable

from .. import store
from ..fetch import ladder
from . import info_blogs, info_text

SOURCE_KEY = "wire.financialjuice"
TASK = "info_wire_financialjuice"
LABEL = "Financial Juice"
SITE_URL = "https://www.financialjuice.com/home"
FEED_URL = "https://www.financialjuice.com/feed.ashx?xy=rss"

# 넣는 줄의 나이 상한(시간). 피드는 최근 100건이라 평소에는 닿지 않습니다 — 주말 뒤 첫 실행에 묵은 줄을 통째로 넣지 않게.
MAX_AGE_HOURS = 48
# 제목 앞에 붙어 오는 꼬리표(출처 이름은 따로 저장하므로 뗍니다).
TITLE_PREFIX = "FinancialJuice:"

Fetch = Callable[..., ladder.Fetched]


def clean_title(title: str) -> str:
    """제목 앞의 출처 꼬리표를 뗍니다(대소문자 무시). 꼬리표뿐이면 빈 글."""
    text = (title or "").strip()
    if text.lower().startswith(TITLE_PREFIX.lower()):
        text = text[len(TITLE_PREFIX):].strip()
    return text


def collect(*, fetch: Fetch = ladder.fetch, now: datetime | None = None) -> str:
    """
    속보 피드를 받아 새 줄을 넣습니다 → 실행 기록 한 줄.

    :raises info_text.ShapeError: 피드에서 줄을 읽지 못함
    :raises ladder.FetchRejected: 피드가 거부됨
    :raises ladder.FetchSkipped: 보내지 못함(예산·시간)
    :raises ladder.FetchFailed: 받지 못함(404·5xx)
    """
    now = now or datetime.now(timezone.utc)
    fetched = fetch(FEED_URL)
    entries = [dict(entry, title=clean_title(entry["title"])) for entry in info_blogs.parse_feed(fetched.body)]
    entries = [entry for entry in entries if entry["title"]]
    if not entries:
        raise info_text.ShapeError("속보 피드의 제목이 모두 비어 있음(형식이 다름)")

    ids = {info_text.item_id(entry["url"]): entry for entry in entries}
    known = store.info_known(list(ids))
    oldest = now - timedelta(hours=MAX_AGE_HOURS)
    items = []
    for item_id, entry in ids.items():
        if item_id in known:
            continue
        published = entry["published_at"]
        if published is not None and published < oldest:
            continue
        text = entry["text"] if entry["text"] and entry["text"] != entry["title"] else ""
        items.append({
            "id": item_id, "source": SOURCE_KEY, "kind": "headline", "url": entry["url"], "title": entry["title"],
            "author": None, "published_at": published, "summary": info_text.summarize(text),
            "body": None, "body_status": "none", "fetch_tier": fetched.tier, "meta": {},
        })
    # 겹치는 줄이 하나도 없는데 전에 받은 적이 있으면 그 사이를 놓쳤을 수 있습니다(넣기 전에 봅니다 — 첫 실행은 늘 전부 처음).
    gap = not known and store.info_source_exists(SOURCE_KEY)
    store.upsert_info_items(items)
    detail = f"{LABEL} 속보 {len(entries)}건 · 새로 넣음 {len(items)} · 계층 {fetched.tier}"
    if gap:
        detail += " · 누락 가능(받은 줄이 모두 처음 봄 — 지난 수집 뒤 100건 넘게 나왔을 수 있음)"
    return detail
