"""
app/tasks/search_watch.py
polite 그룹(비주기 — 운영 서버에서만) — 정보 검색의 관심 대상 정기 수집(ADR 0041 결정 9, 계약 docs/specs/2026-11-14-info-search-contract.md §6-3).

사용자가 등록한 관심 대상(백엔드 표 search_watches — 읽기만, 대표 키마다 한 번)의 새 글을 낮은 빈도로 모아 수집기 표 search_watch_items에
넣습니다. 화면은 그 표에서 타임라인을 그리고 '마지막으로 본 뒤 새 글 수'를 셉니다(백엔드). **모의 매매의 입력이 아닙니다.**

[언제]
  - 태스크는 polite 일정(:data:`CADENCE` 20~40분, 무작위 — 본문이 끝난 뒤부터 재고 polite 틱 지연이 더해짐)으로 깨고, 한 번에 때가 된 대상을
    :data:`ENTITIES_PER_WAKE`(6)개까지 처리합니다 — 하루 약 250곳(깨기 약 42번 × 6)이라 대상마다 3~8시간(하루 평균 4.4번)을 운영자 상한 50곳까지
    지킵니다. 서버 상한 100곳을 다 채우면 차례가 밀려 대상마다 9~10시간쯤이 됩니다. 처리량 상한이 먼저 걸려 구글은 하루 많아야 약 500건(600건 예산
    안), Bing은 0건이라 두 번째 구문을 묻는 일이 잦으면 예산이 바닥날 수 있습니다(그 뒤 그날의 Bing 질의는 보내지 않음 — 아래 판정).
    공시(단계 4)는 대상마다 출처당 한 건이라 하루 많아야 약 250건씩(SEC 회사별 목록·DART 600, EDGAR 전문 검색 300 예산 안).
    Finviz(단계 5)는 미국 상장 회사 대상마다 한 건이고 즉석 검색과 같은 30분 캐시를 써, 하루 많아야 약 250건이 예산 100에서 멈춥니다(그 뒤
    그날의 Finviz 질의는 보내지 않음 — 미국 종목 대상이 많으면 대상마다 하루 한 번도 못 받을 수 있음).
    바깥 요청은 대상마다 많아야 10건(구글 2·Bing 2~4·공시 3·Finviz 1 — 공시 셋과 Finviz를 모두 받는 대상은 없어 실제로는 8건 이하)이라 한 번
    깰 때 많아야 60건, 사이 2~5초(많아야 약 300초)에 요청 시간과 Finviz 계층의 같은 호스트 간격(4~15초, 가끔 20~45초)을 더해도 대개 시간
    상한(600초) 안이고, 넘으면 남은 대상은 다음 깨기로 미룹니다(아래 판정).
  - 대상마다 다음 시각은 fetch_schedule의 ``search_watch/<대표 키의 md5 앞 16자>`` 줄에 3~8시간(180~480분, 무작위)으로 둡니다 — 처리를 시작하기
    전에 먼저 적어, 실행이 끊겨도 같은 대상을 곧바로 다시 묻지 않습니다. 줄 이름에 대표 키를 그대로 두지 않습니다(회원이 쓴 ``topic:`` 글이 운영자
    메커니즘 화면의 일정 목록에 드러나지 않게 — ADR 0041 결정 12의 취지). 처음 등록된 대상(줄이 없음)은 다음 깨기에서 바로 처리합니다(줄 없는
    대상 먼저, 그다음 오래 기다린 대상).
  - ``POLITE_FETCH_ENABLED``가 꺼진 곳(로컬·QA)에서는 polite.scheduled가 본문을 부르지 않습니다(외부·DB 0건 — 시험).

[한 대상의 처리]
  1. 저장본 대조(외부 호출 0건): 새 피드 묶음(90일)·사건 뉴스(7일)·속보·수집 글에서 별칭이 제목·요약(수집 글은 본문까지)에 든 글. 영문은 단어 경계,
     한글은 포함, 네 글자 미만 별칭은 쓰지 않음(대상 이름은 짧아도 씀 — 정보 검색 규칙 5와 같은 대조어 rules.match_terms). 등록 표에는 이름 하나와
     별칭만 있어, 등록 때의 이름 둘(한·영)은 :func:`watch_entity`가 별칭 맨 앞에서 되살립니다(즉석 검색과 같은 검색어).
  2. 바깥 질의: 구글 뉴스 RSS(한국어·영어 판)·Bing 뉴스 RSS(판마다 검색식 하나 — 한 단어 이름뿐인 미국 종목은 영어 판에 티커를 붙임, 0건이면 다음 검색식으로 한 번 더 — sources.bing) — 단계 2의
     함수(services/search_sources)와 계약 4절의 검색식, 공용 세션.
     요청마다(Bing의 두 번째 구문 포함) 호스트 하루 예산(표 fetch_budgets, purpose ``watch`` — news.google.com 600·www.bing.com 600, KST 날짜)에서 한 건을 쓰고, 예산이
     없으면 그 질의를 보내지 않습니다(그 대상은 저장본 대조만 하고 다음 시각을 잡음). 한 번 깰 때의 바깥 요청은 차례로, 사이 2~5초(무작위) +
     공용 세션의 호스트 간격.
  3. 공시(단계 4 — 계약 §7-6, 함수는 services/search_filings): 대상에 CIK가 있으면 SEC 회사별 목록(data.sec.gov 600), 종류가 사람·13F 기관이면
     EDGAR 이름 전문 검색 첫 구문 한 번(efts.sec.gov 300 — 두 번째 구문은 묻지 않음), DART 고유번호가 있으면 DART 첫 쪽(opendart.fss.or.kr 600).
     예산·간격·판정은 2와 같고, 넣는 줄은 kind ``filing``(id는 접수번호·DART 주소 — 정보 검색과 같음). 리서치·연결은 모으지 않습니다.
     설정(SEC_USER_AGENT·DART_API_KEY)이 없으면 그 질의는 보내지 않고 예산·간격·요청 수도 쓰지 않습니다(실행 기록에 안내 한 번 — 아래 판정).
  4. Finviz(단계 5 — 계약 §8-7, services/search_finviz): 미국 상장 회사(티커)면 종목 화면 한 쪽의 뉴스 표. 즉석 검색과 같은 잠금(finviz.com에
     동시에 두 건이 나가지 않음)·같은 30분 캐시(캐시가 있으면 요청·예산 없음)를 거치고, 예산은 finviz.com 100(용도 watch)·간격은 2와 같음 —
     계층(차단 통과 수집)의 같은 호스트 간격과 계층 예산 250도 그 위에 걸림. 거부(닫힘·포기)는 그 대상의 Finviz만 건너뜀(호스트 닫힘은 계층이
     표 fetch_hosts에 기록 — 이미 닫혀 있으면 예산을 쓰기 전에 건너뜀, 다른 출처는 계속, 실행 기록에 'Finviz 건너뜀'). 태스크의 남은 시간이
     계층 한 번 올림에 모자라면(search_finviz.WATCH_MIN_TIME_LEFT) 묻지 않음. 받지 못함·형식 바뀜·종목 화면이 아닌 곳으로 옮겨짐은 '받지 못함'.
  5. 넣기 전 규칙: 2년 자르기·중국어 제목·'.cn'·매체 제외(처음 값 + 사용자가 더한 search_media_excludes), 같은 글 가리기(출처 우선순위: 저장본 >
     Finviz > Bing > 구글 > SEC 회사별 목록 > EDGAR 전문 검색 > DART — 정보 검색과 같이 Finviz는 Yahoo 바로 뒤). 저장하는 글 id(:func:`stored_id`)는 원문 주소면 ``info_text.item_id``, 경유 주소(구글)면 그 기사 경로(``/rss/articles/<id>``,
     인자 없음)의 같은 해시, 주소가 없으면 전체 제목의 해시입니다 — 제목 앞 24자(계약 규칙 4 — 한 요청 안에서 출처끼리 겹친 줄을 가리는 임시 키)는
     2년 보관 키로 쓰지 않습니다(앞 24자가 같은 다른 기사를 막지 않게). 경유 주소 줄·주소 없는 줄은 같은 실행이나 그 대상의 저장본에 **전체 제목**이
     같은 글이 있으면 넣지 않습니다. 이미 있는 (대상, 글)은 그대로 둡니다(처음 받은 시각을 지킴). 처음 받은 시각은 지금이고, 작성 시각이 없는 저장본
     글(시각 칸 없는 피드·수집 글)은 그 글을 처음 받은 시각을 씁니다.

[정리 — 깰 때 확인, 표 전체를 훑는 일은 드물게]
  - KST 하루 한 번(그날 첫 깨기): 더는 아무도 등록하지 않은 대상의 글 — 그 대상의 일정 줄이 마지막으로 고쳐진 뒤 7일이 지나면(다시 등록하면 남음)
    글과 일정 줄을 지웁니다. 2년 지난 글(색인 search_watch_items_time).
  - 제외 목록(처음 값 + 사용자가 더한 매체)이 바뀌었을 때(과정이 처음 깰 때 포함): 그 목록에 걸리는 매체의 글. 새로 넣는 글은 넣기 전에 이미 거릅니다.
  - 정리 문장에는 시간 상한(store.SEARCH_PURGE_TIMEOUT_MS)이 있고, 실패하면 실행 기록에 '정리 못 함'만 적고 수집은 이어 갑니다(다음 깨기에 다시).

[판정]
  - 저장본·바깥 질의가 일부 실패하면 받은 것은 넣고 Partial(``failed`` — 출처 상태 '받지 못함').
  - 하루 예산으로 보내지 않은 질의는 출처의 끊김이 아닙니다(Bing은 0건이면 판마다 한 건 더 묻기 때문에 대상이 많고 0건이 잦으면 바닥날 수 있음). 보낸 요청이 모두 성공했으면 '정상'이고, 예산이 모두 바닥나 하나도 보내지 못한 깨기는 직전 판정이 '정상'(또는 없음)일 때만 '정상'으로 적습니다 — 그래야 예산이
    바닥난 동안 마지막 성공 시각이 멈춰 '오래 못 받음'(간격 상한 40분 × 3)이 거짓으로 나지 않고, 닿지 못한 출처의 '받지 못함'을 지우지도 않습니다
    (그때는 Partial ``unsent`` — 출처 상태 그대로).
  - 태스크 시간 상한으로 남긴 대상이 있으면 Partial(``unsent``).
  - Finviz를 건너뛴 대상(거부·닫힘·직전 실패·즉석 검색의 요청을 기다리다 넘김·남은 시간·계층 예산)은 판정과 무관합니다 — 실행 기록에
    'Finviz 건너뜀'만. Finviz 즉석 검색이 새로 거부당하면 search_finviz가 이 태스크의 판정을 'blocked'로 남겨 끊김 알림에 걸리고, 이 태스크의
    다음 성공이 지웁니다(이미 닫혀 보내지 않은 즉석 검색은 다시 걸지 않음).
  - 설정이 없어 보내지 않은 공시 질의(SEC_USER_AGENT·DART_API_KEY)도 출처의 끊김이 아닙니다 — 실행 기록에 '설정이 없어 보내지 않음'만 적고
    판정은 보낸 요청으로 합니다(실행마다 같은 '받지 못함'이 쌓이지 않게 — DART 키가 있는지는 수집기 ``/status``의 ``keys``에도 보임).
  - 검색어·경로는 로그와 실행 기록에 남기지 않습니다(호스트·상태 코드만 — 단계 2의 사유 글).
"""
from __future__ import annotations

import hashlib
import logging
import random
import re
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from .. import kst, store
from ..services import info_text, search_filings, search_finviz
from ..services import search_rules as rules
from ..services import search_sources as sources
from ..services import search_store
from . import flex, polite

logger = logging.getLogger(__name__)

TASK_NAME = "search_watch"
CADENCE = polite.Cadence(low_minutes=20.0, high_minutes=40.0)
ENTITIES_PER_WAKE = 6
ENTITY_MINUTES = (180.0, 480.0)
PURPOSE = "watch"
GOOGLE_HOST = "news.google.com"
BING_HOST = "www.bing.com"
SEC_DATA_HOST = search_filings.SEC_HOST         # data.sec.gov — SEC 회사별 목록(단계 4)
EFTS_HOST = search_filings.EFTS_HOST            # efts.sec.gov — EDGAR 이름 전문 검색(단계 4)
DART_HOST = search_filings.DART_HOST            # opendart.fss.or.kr — DART 공시 목록(단계 4)
FINVIZ_HOST = search_finviz.HOST                # finviz.com — Finviz 종목 뉴스(단계 5)
DAILY_BUDGETS = {GOOGLE_HOST: 600, BING_HOST: 600, SEC_DATA_HOST: 600, EFTS_HOST: 300, DART_HOST: 600,
                 FINVIZ_HOST: search_finviz.WATCH_BUDGET}
FTS_KINDS = ("person", "institution")           # EDGAR 이름 전문 검색을 묻는 대상 종류
_CIK = re.compile(r"^\d{10}$")
_CORP_CODE = re.compile(r"^\d{8}$")
REQUEST_SPACING_SECONDS = (2.0, 5.0)
UNWATCHED_GRACE_DAYS = 7
# 새 대상을 더 시작하지 않는 경과 시간(초) — polite 상한(900초) 전에 멈춥니다. 남은 대상은 일정을 건드리지 않아 다음 깨기가 다시 고릅니다.
TIME_LIMIT_SECONDS = 600.0
SCHEDULE_PREFIX = flex.key(TASK_NAME, "")
SCHEDULE_HASH_CHARS = 16        # 일정 줄 이름의 대표 키 해시(md5) 앞 글자 수 — store.purge_unwatched_search_items의 SQL과 같은 값
# 같은 글이 여러 곳에서 오면 앞의 것이 남습니다(계약 §4-4: 저장본 > Bing > 구글, §7-4: 그 뒤 SEC 회사별 목록 > EDGAR 전문 검색 > DART,
# §8-3: Finviz는 Yahoo 바로 뒤 — 여기에는 Yahoo가 없어 저장본 바로 뒤).
PRIORITY = ("feeds", "event_news", "info", "wire", "finviz", "bing", "google_ko", "google_en", "sec", "sec_fts", "dart")

# 시험이 난수를 바꿔 끼우는 자리입니다.
_rng = random.Random()

# 정리를 마지막으로 한 KST 날짜와 그때의 제외 목록(과정 안에서만 — 재기동하면 처음 깰 때 다시 정리).
_maintenance: dict = {"day": None, "excludes": None}


def reset_maintenance() -> None:
    """시험용 — 정리 표지를 비웁니다(다음 깨기에 정리를 모두 다시)."""
    _maintenance.update(day=None, excludes=None)


def schedule_item(entity_key: str) -> str:
    """대상의 일정 줄 항목 이름 — 대표 키의 md5 앞 16자(이름표일 뿐 보안용 해시가 아님, SQL ``left(md5(key), 16)``과 같음)."""
    return hashlib.md5(entity_key.encode("utf-8"), usedforsecurity=False).hexdigest()[:SCHEDULE_HASH_CHARS]


def watch_entity(target: dict) -> dict:
    """
    등록 표의 대상 → 검색어를 만들 대상(``nameKo``·``nameEn``을 되살림). 대상 풀기(search_entities.finish)는 별칭 맨 앞에 이름(한·영)을 두고 그 뒤
    별칭은 네 글자 이상만 남기며, 백엔드는 그 순서 그대로 저장합니다. 그래서 대표 이름과 별칭 앞 두 개 가운데 한글이 든 첫 글자를 한국어 이름,
    한글이 없는 첫 글자를 영문 이름으로 봅니다 — 이름이 하나뿐인 대상이면 두 번째 자리는 (네 글자 이상의) 보통 별칭이라 이름으로 봐도 검색어에
    늘 넣을 뿐입니다(티커·중국어는 rules._names가 다시 뺌).
    """
    heads = [text.strip() for text in [target.get("name") or "", *list(target.get("aliases") or [])[:2]]
             if isinstance(text, str) and text.strip()]
    name_ko = next((text for text in heads if rules.has_hangul(text)), None)
    name_en = next((text for text in heads if not rules.has_hangul(text)), None)
    return dict(target, nameKo=name_ko, nameEn=name_en)


def task_search_watch() -> str:
    """관심 대상 정기 수집 — 운영 서버에서만(polite), 한 번에 때가 된 대상 6개까지."""
    return polite.scheduled(TASK_NAME, CADENCE, _work)


# ==============================================================================
# 본문
# ==============================================================================
def _work() -> str | polite.Partial:
    now = _now()
    started = _clock()
    excludes = search_store.user_excludes()
    purge_note = _purge(now, excludes)
    targets = store.search_watch_targets()
    if not targets:
        return f"관심 대상 없음 · {purge_note} · 외부 호출 0회"
    schedule = flex.due_map(TASK_NAME)
    due = {target["key"]: schedule.get(schedule_item(target["key"])) for target in targets}
    waiting = [target for target in targets if due[target["key"]] is None or due[target["key"]] <= now]
    # 처음 등록된 대상(일정 없음) 먼저, 그다음 오래 기다린 대상.
    waiting.sort(key=lambda t: (due[t["key"]] is not None, due[t["key"]] or now, t["key"]))
    picked = waiting[:ENTITIES_PER_WAKE]
    if not picked:
        upcoming = min(when for when in due.values() if when is not None)
        return f"때가 된 관심 대상 없음(등록 {len(targets)}곳 · 다음 {kst.stamp(upcoming)}) · {purge_note} · 외부 호출 0회"

    pace = {"sent": 0}
    done: list[str] = []
    inserted = 0
    requests_sent = 0
    failures: list[str] = []
    over_budget: list[str] = []
    over_time: list[str] = []
    unconfigured: list[str] = []
    finviz_notes: list[str] = []
    for index, target in enumerate(picked):
        if _clock() - started > TIME_LIMIT_SECONDS:
            over_time.append(f"시간 상한으로 대상 {len(picked) - index}곳은 다음 깨기")
            break
        flex.set_due(TASK_NAME, schedule_item(target["key"]), now + timedelta(minutes=_rng.uniform(*ENTITY_MINUTES)))
        outcome = _collect(target, now, excludes, pace)
        done.append(target["key"])
        inserted += outcome["inserted"]
        requests_sent += outcome["requests"]
        failures += outcome["failures"]
        over_budget += outcome["unsent"]
        unconfigured += outcome["unconfigured"]
        finviz_notes += outcome["finviz"]

    left = len(waiting) - len(done)
    detail = (f"관심 대상 {len(done)}/{len(targets)}곳 처리 · 새 글 {inserted}건 · 바깥 요청 {requests_sent}건"
              + (f" · 때가 된 대상 {left}곳은 다음 깨기" if left > 0 else "") + f" · {purge_note}")
    if over_budget:
        detail += f" · 하루 예산으로 보내지 않음({'; '.join(dict.fromkeys(over_budget))})"
    if unconfigured:
        detail += f" · 설정이 없어 보내지 않음({'; '.join(dict.fromkeys(unconfigured))})"
    if finviz_notes:
        detail += f" · Finviz 건너뜀({'; '.join(dict.fromkeys(finviz_notes))})"
    if failures:
        return polite.Partial(detail, "; ".join(dict.fromkeys(failures))[:300], kind=polite.PARTIAL_FAILED)
    if over_time:
        return polite.Partial(detail, "; ".join(over_time + list(dict.fromkeys(over_budget)))[:300], kind=polite.PARTIAL_UNSENT)
    if over_budget and not requests_sent and not _last_verdict_ok():
        # 예산이 모두 바닥나 한 건도 보내지 못함 — 직전 판정(받지 못함·거부 등)을 '정상'으로 덮지 않습니다.
        return polite.Partial(detail, "; ".join(dict.fromkeys(over_budget))[:300], kind=polite.PARTIAL_UNSENT)
    return detail


def _last_verdict_ok() -> bool:
    """이 태스크의 직전 판정이 '정상'(또는 아직 없음)인가. 읽지 못하면 False(덮어쓰지 않는 쪽)."""
    try:
        state = store.source_state(TASK_NAME)
    except Exception as exc:  # noqa: BLE001
        logger.info("관심 대상 수집: 직전 판정을 읽지 못함(%s)", type(exc).__name__)
        return False
    return state is None or state.get("status") == "ok"


def _collect(target: dict, now: datetime, excludes: rules.Excludes, pace: dict) -> dict:
    """
    대상 하나 — 저장본 대조 → 바깥 질의(예산 안에서) → 규칙 → 넣기. 검색어는 어디에도 남기지 않습니다.

    :param pace: 이번 깨기에 보낸 바깥 요청 수({"sent": n}) — 두 번째 요청부터 앞에 간격을 둡니다(대상이 바뀌어도 이어 셈)
    """
    entity = watch_entity(target)
    terms = rules.match_terms(entity)
    groups: dict[str, list[dict]] = {}
    failures: list[str] = []
    unsent: list[str] = []
    unconfigured: list[str] = []
    finviz_notes: list[str] = []

    # 1. 저장본 대조 — 외부 호출 0건.
    for source, read in (("feeds", search_store.feed_bundle), ("event_news", search_store.event_news),
                         ("wire", search_store.wire), ("info", search_store.info_posts)):
        if not terms:
            break
        result = read(terms)
        if result.error:
            failures.append(f"저장본 {source} {result.error}")
        groups[source] = list(result.items)

    # 2. 바깥 질의 — 호스트 하루 예산(KST 날짜) 안에서, 요청 사이 간격.
    today = rules.kst_today(now)
    window_from = rules.window(today)[0]
    ko, en = rules.edition_terms(entity, "ko"), rules.edition_terms(entity, "en")
    sent = {"requests": 0}

    def take(host: str) -> bool:
        """요청 한 건 — 그 호스트의 하루 예산에서 한 건을 쓰고(없으면 보내지 않음) 두 번째 요청부터 앞에 간격을 둡니다."""
        if not store.take_search_budget(host, PURPOSE, today, DAILY_BUDGETS[host]):
            unsent.append(f"{host} 하루 예산 {DAILY_BUDGETS[host]}건 소진")
            return False
        if pace["sent"]:
            _sleep(_rng.uniform(*REQUEST_SPACING_SECONDS))
        pace["sent"] += 1
        sent["requests"] += 1
        return True

    target_ids = target.get("ids") or {}
    us_ticker = target_ids.get("ticker") if target.get("kind") == "company" and target_ids.get("market") == "us" else None
    queries = (
        ("bing", BING_HOST, ko, lambda: sources.bing({"ko": ko}, before_retry=lambda: take(BING_HOST))),
        ("bing", BING_HOST, en, lambda: sources.bing({"en": en}, before_retry=lambda: take(BING_HOST), ticker=us_ticker)),
        ("google_ko", GOOGLE_HOST, ko, lambda: sources.google(ko, "ko", after=window_from)),
        ("google_en", GOOGLE_HOST, en, lambda: sources.google(en, "en", after=window_from)),
    )
    for source, host, edition, call in queries:
        # 보낼 질의가 없으면(따옴표·공백뿐인 주제 등) 예산·간격·요청 수를 쓰지 않습니다.
        askable = sources.bing_queries(edition) if host == BING_HOST else rules.build_query(edition)
        if not askable or not take(host):
            continue
        result = call()
        if result.error:
            failures.append(f"{source} {result.error}")
        groups.setdefault(source, []).extend(result.items)

    # 3. 공시(단계 4) — 출처마다 한 건, 같은 예산·간격. 설정이 없으면 보내지 않고 예산·간격·요청 수도 쓰지 않습니다.
    for source, host, call in _filing_queries(target, en, window_from, today.isoformat()):
        unready = search_filings.dart_unready() if host == DART_HOST else search_filings.sec_unready()
        if unready:
            unconfigured.append(unready)
            continue
        if not take(host):
            continue
        result = call()
        if result.error:
            failures.append(f"{source} {result.error}")
        groups.setdefault(source, []).extend(result.items)

    # 4. Finviz(단계 5) — 미국 상장 회사만. 즉석 검색과 같은 잠금·캐시(캐시가 있으면 예산·간격·요청 수를 쓰지 않음), 예산·간격은 take.
    if us_ticker:
        answer = search_finviz.for_watch(us_ticker, take=lambda: take(FINVIZ_HOST))
        if answer.took and not answer.sent:
            sent["requests"] -= 1       # 예산은 썼지만 계층이 보내지 않음(닫힘·계층 예산·시간) — 보낸 요청으로 세지 않음
        if answer.failure:
            failures.append(f"finviz {answer.failure}")
        if answer.note:
            finviz_notes.append(answer.note)
        groups["finviz"] = list(answer.items)
    requests = sent["requests"]

    # 5. 규칙 → 같은 글 가리기 → 넣기.
    start = rules.window_start(today)
    kept_groups = []
    for source in PRIORITY:
        kept, _, _ = rules.apply_rules(groups.get(source, []), start=start, now=now, excludes=excludes)
        kept_groups.append(kept)
    merged = _merge(kept_groups)
    rows = _rows(target["key"], merged, now)
    inserted = store.insert_search_watch_items(target["key"], rows) if rows else 0
    return {"inserted": inserted, "requests": requests, "failures": failures, "unsent": unsent, "unconfigured": unconfigured,
            "finviz": finviz_notes}


def _filing_queries(target: dict, en_terms: list[str], window_from: str, window_to: str) -> list[tuple]:
    """
    대상의 공시 질의(계약 §7-6) — [(출처, 호스트, 부르기)]. CIK(10자리)면 SEC 회사별 목록, 사람·13F 기관이면 EDGAR 이름 전문 검색의 첫 구문 하나
    (``bing_queries`` — 정보 검색과 같은 구문, 두 번째 구문은 묻지 않음), DART 고유번호(8자리)면 DART 첫 쪽.
    """
    ids = target.get("ids") or {}
    queries: list[tuple] = []
    cik = ids.get("cik")
    if isinstance(cik, str) and _CIK.match(cik):
        queries.append(("sec", SEC_DATA_HOST, lambda: search_filings.sec_submissions(cik, start_day=window_from)))
    if target.get("kind") in FTS_KINDS:
        first = sources.bing_queries(en_terms)[:1]
        if first:
            queries.append(("sec_fts", EFTS_HOST, lambda: search_filings.sec_fts(first, start_day=window_from, end_day=window_to,
                                                                                  max_phrases=1)))
    corp = ids.get("dartCorpCode")
    if isinstance(corp, str) and _CORP_CODE.match(corp):
        queries.append(("dart", DART_HOST, lambda: search_filings.dart_list(corp, start_day=window_from, end_day=window_to,
                                                                            max_pages=1)))
    return queries


def full_title(title: str | None) -> str:
    """전체 제목의 대조 키 — 계약 규칙 4의 제목 키와 같게 정규화하되 앞 24자로 자르지 않습니다."""
    return re.sub(r"\W+", "", (title or "").lower())


def stored_id(item: dict) -> str:
    """
    저장하는 글 id — 원문 주소면 FeedItem의 id(``info_text.item_id`` — 수집 글이면 info_items의 id와 같음), 경유 주소(구글)면 그 기사 경로
    (인자 없이)의 ``info_text.item_id``, 주소가 없으면 전체 제목의 해시. 제목 앞 24자(같은 요청 안의 임시 키)는 쓰지 않습니다.
    """
    url = item.get("url")
    if url and rules.is_relay(url):
        parts = urlsplit(url)
        return info_text.item_id(f"https://{parts.hostname}{parts.path}")
    if url and rules.domain_of(url):
        return item["id"]
    title = full_title(item.get("title"))
    return "t" + hashlib.sha1(title.encode("utf-8")).hexdigest()[:23] if title else item["id"]


def _is_weak(item: dict) -> bool:
    """경유 주소(구글)뿐이거나 주소가 없는 줄 — 같은 기사의 원문 주소 줄이 있으면 그쪽을 남깁니다."""
    return rules.is_relay(item.get("url")) or not item.get("url")


def _merge(groups: list[list[dict]]) -> list[dict]:
    """
    출처 묶음(우선순위 높은 것부터)을 합쳐 같은 글을 한 번만 — 키는 :func:`stored_id`, 경유 주소·주소 없는 줄은 앞서 남은 줄과 **전체 제목**이
    같으면 뺍니다. 정보 검색의 rules.merge(제목 앞 24자)와 달리 저장할 줄을 고르므로 앞 24자가 같은 다른 기사를 남깁니다. 줄의 ``id``는 저장 id.
    """
    seen_ids: set[str] = set()
    seen_titles: set[str] = set()
    out: list[dict] = []
    for group in groups:
        for item in group:
            key = stored_id(item)
            title = full_title(item.get("title"))
            if not key or key in seen_ids or (title and _is_weak(item) and title in seen_titles):
                continue
            seen_ids.add(key)
            if title:
                seen_titles.add(title)
            out.append(dict(item, id=key))
    return out


def _rows(entity_key: str, items: list[dict], now: datetime) -> list[dict]:
    """
    FeedItem(:func:`_merge`를 거친 — ``id``가 저장 id) → search_watch_items 행. 이미 있는 글은 빼고, 경유 주소·주소 없는 줄은 그 대상의 저장본에
    전체 제목이 같은 글이 있으면 뺍니다.
    """
    existing = store.search_watch_item_titles(entity_key)
    known_ids = {row["item_id"] for row in existing}
    known_titles = {full_title(row["title"]) for row in existing}
    rows = []
    for item in items:
        if item["id"] in known_ids:
            continue
        title = full_title(item["title"])
        if _is_weak(item) and title and title in known_titles:
            continue
        moment = rules.parse_time(item.get("publishedAt"))
        fetched_basis = item.get("timeBasis") == "fetched"
        rows.append({
            "item_id": item["id"],
            "kind": item.get("kind") or "news",
            "title": item["title"],
            "url": item.get("url"),
            "publisher": item.get("publisher"),
            "publisher_domain": item.get("publisherDomain"),
            "source": item["source"],
            "lang": item.get("lang"),
            "summary": item.get("summary"),
            # 작성 시각이 없는 저장본 글은 그 글을 처음 받은 시각을 처음 받은 시각으로(작성 시각은 모름 — NULL).
            "published_at": None if fetched_basis else moment,
            "first_seen_at": min(moment, now) if fetched_basis and moment is not None else now,
        })
        known_ids.add(item["id"])
        if title:
            known_titles.add(title)
    return rows


def _purge(now: datetime, excludes: rules.Excludes) -> str:
    """
    정리 — KST 하루 한 번 아무도 등록하지 않은 대상의 글(7일 유예 뒤)·2년 지난 글, 제외 목록이 바뀌었을 때 제외 매체의 글 → 실행 기록 한 토막.
    정리가 실패해도(시간 상한 등) 수집은 이어 가고 표지를 그대로 두어 다음 깨기에 다시 합니다.
    """
    today = rules.kst_today(now)
    parts: list[str] = []
    failed: list[str] = []
    if _maintenance["day"] != today:
        try:
            unwatched, schedule_rows = store.purge_unwatched_search_items(SCHEDULE_PREFIX, UNWATCHED_GRACE_DAYS,
                                                                          SCHEDULE_HASH_CHARS)
            old = store.delete_search_watch_items_before(rules.window_start(today))
            _maintenance["day"] = today
            if unwatched or schedule_rows:
                parts.append(f"등록이 풀린 대상의 글 {unwatched}건(일정 {schedule_rows}줄)")
            if old:
                parts.append(f"2년 지난 글 {old}건")
        except Exception as exc:  # noqa: BLE001 — 정리는 다음 깨기에 다시
            logger.warning("관심 대상 수집: 정리 못 함(%s)", type(exc).__name__)
            failed.append(type(exc).__name__)
    if _maintenance["excludes"] != excludes:
        try:
            pairs = [(row["publisher"], row["publisher_domain"]) for row in store.search_watch_item_publishers()
                     if rules.is_excluded_media(row["publisher_domain"], row["publisher"], excludes)]
            excluded = store.delete_search_watch_items_by_publisher(pairs)
            _maintenance["excludes"] = excludes
            if excluded:
                parts.append(f"제외 매체 글 {excluded}건")
        except Exception as exc:  # noqa: BLE001
            logger.warning("관심 대상 수집: 제외 매체 정리 못 함(%s)", type(exc).__name__)
            failed.append(type(exc).__name__)
    done = "정리 " + (" · ".join(parts) if parts else "없음")
    if failed:
        return (f"{done} · " if parts else "") + f"정리 못 함({', '.join(dict.fromkeys(failed))}) — 다음 깨기에 다시"
    return done


# ==============================================================================
# 작은 도구 — 테스트가 바꿔 끼우는 자리
# ==============================================================================
def _now() -> datetime:
    return datetime.now(timezone.utc)


def _clock() -> float:
    return time.monotonic()


def _sleep(seconds: float) -> None:
    time.sleep(seconds)
