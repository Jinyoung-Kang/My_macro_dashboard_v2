"""
app/services/search_wikidata.py
정보 검색(ADR 0041 결정 4)의 Wikidata 읽기 — 한국어·영어 이름·별칭·설명과 관계만 받습니다(다른 언어는 받지 않음).

- 요청은 공용 세션(호스트 간격·거부 래치)으로 하되 User-Agent는 연락처 없는 일반 이름(``LocalMacroDashboard/2.0`` — D-5, 2026-11-14 서버 실측 200).
  같은 호스트로는 MIN_INTERVAL초 넘게 띄워 차례로 보냅니다(로컬 실측: 몇 초 안에 약 15건이면 429 — 그때는 공용 래치가 5분 닫음).
- 쓰는 API: ``wbsearchentities``(이름 찾기 — 한글이 있으면 ko, 아니면 en), ``query&list=search``(CirrusSearch ``haswbstatement:`` — CIK로 찾기·사람
  가리기·역방향 관계), ``wbgetentities``(``labels|aliases|descriptions|claims``, ``languages=ko|en``).
- 관계: P1830 소유 · P127 소유자 · P112 창업자 · P108 소속 · P169 대표 · P749 모회사 · P355 자회사. 역방향은 사람에게만 P112(창업)를
  CirrusSearch로 찾습니다. 지운(deprecated) 문장과 끝난(P582) 관계는 뺍니다. 상장(P414)의 한정자 P249가 티커, P5531이 CIK입니다.
  티커는 거래소(P414 값)와 함께 읽고, 미국·한국 대표 키(us:·kr:)에는 미국·한국 거래소 문장의 티커만 씁니다(해외 거래소의 같은 티커·본국 숫자 코드가
  다른 회사로 풀리지 않게).
- 법인 식별자(LEI, 단계 4 — 계약 §7-5): P1278 문장 가운데 20자 모양(``[A-Z0-9]{18}[0-9]{2}``)이 맞는 첫 값. 연결 탭의 GLEIF 법인 관계를 이 값으로만
  찾습니다(이름 검색은 해외 자회사가 먼저 나옴).
- 실패 사유는 호스트와 상태 코드만(검색어·인자 없음). 읽기(``parse_*``)는 순수 함수입니다.
"""
from __future__ import annotations

import re
from typing import Any, Iterable

from .. import http
from .search_sources import safe_reason

WIKIDATA_API = "https://www.wikidata.org/w/api.php"
USER_AGENT = "LocalMacroDashboard/2.0"
LANGUAGES = "ko|en"
TIMEOUT = (5, 10)
MAX_IDS = 50
MAX_LINKS_PER_RELATION = 15

RELATION_PROPS = {"P1830": "owner_of", "P127": "owned_by", "P112": "founded_by", "P108": "employer", "P169": "ceo",
                  "P749": "parent", "P355": "subsidiary"}
# 역방향은 창업(P112)만 — 대표(P169) 역방향까지 찾으면 사람 하나에 Wikidata 호출이 하나 더 늘어(2026-11-14 로컬 실측에서 연달아 약 15건에
# HTTP 429) 줄였습니다.
REVERSE_PROPS = {"P112": "founder_of"}
HUMAN = "Q5"
# 조직으로 보는 P31 종류(2026-11-14 라벨 확인): 사업 · 상장 기업 · 기업(enterprise) · 회사 · 단체 · 기업(corporation) · 지주회사 · 소프트웨어 회사 ·
# 자산운용사.
ORGANIZATION_TYPES = frozenset({"Q4830453", "Q891723", "Q6881511", "Q783794", "Q43229", "Q167037", "Q219577", "Q1058914",
                                "Q4230006"})
# 상장(P414) 거래소 — 2026-11-14 Wikidata에서 라벨과 haswbstatement:P414 건수로 확인.
# 미국: NYSE · Nasdaq · NYSE American · NYSE Arca · Cboe BZX · OTC Markets Group.
# 한국: 한국거래소(Q495372 — 삼성전자 005930의 상장 문장이 이것) · 한국거래소 유가증권시장(Q495364) · 코스닥(Q491503).
US_EXCHANGES = frozenset({"Q13677", "Q82059", "Q846626", "Q10593835", "Q107188457", "Q1930860"})
KR_EXCHANGES = frozenset({"Q495372", "Q495364", "Q491503"})
# 같은 호스트로 가는 Wikidata 요청 사이의 최소 간격(초, 프로세스 전체) — 연락처 없는 일반 이름 UA는 빨리 두드리면 429를 받습니다.
MIN_INTERVAL = 1.0
# 조직으로 볼 근거가 되는 속성(산업·본사·직원 수·매출·법적 형태·상장·CIK·모회사·자회사·대표·창업자).
ORGANIZATION_PROPS = ("P452", "P159", "P1128", "P2139", "P1454", "P414", "P5531", "P749", "P355", "P169", "P112")
_QID = re.compile(r"^Q[1-9]\d{0,11}$")
LEI = re.compile(r"^[A-Z0-9]{18}[0-9]{2}$")
_CIRRUS_UNSAFE = re.compile(r"[^\w\s가-힣.&'-]")


class WikidataError(RuntimeError):
    """Wikidata를 읽지 못함 — 메시지는 화면용 한 줄(호스트와 상태만)."""


def request(params: dict, *, session=None) -> dict:
    """한 번 부르기 → JSON. 실패는 :class:`WikidataError`."""
    query = dict(params)
    query["format"] = "json"
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    http.pace(http.host_of(WIKIDATA_API), MIN_INTERVAL)
    try:
        res = (session if session is not None else http.get_session()).get(WIKIDATA_API, params=query, timeout=TIMEOUT,
                                                                           headers=headers)
    except Exception as exc:  # noqa: BLE001
        raise WikidataError(safe_reason(exc, http.host_of(WIKIDATA_API))) from None
    if res.status_code != 200:
        raise WikidataError(f"{http.host_of(WIKIDATA_API)} HTTP {res.status_code}")
    try:
        payload = res.json()
    except ValueError:
        raise WikidataError(f"{http.host_of(WIKIDATA_API)} 응답이 JSON이 아님") from None
    if not isinstance(payload, dict):
        raise WikidataError(f"{http.host_of(WIKIDATA_API)} 응답 모양이 다름")
    if isinstance(payload.get("error"), dict):
        code = str(payload["error"].get("code") or "error")[:40]
        raise WikidataError(f"{http.host_of(WIKIDATA_API)} 오류 {code}")
    return payload


def api(params: dict) -> dict:
    """시험이 바꿔 끼우는 자리 — 운영에서는 :func:`request` 그대로."""
    return request(params)


# ------------------------------------------------------------------ 읽기(순수 함수)

def _value(snak: Any) -> Any:
    if not isinstance(snak, dict) or snak.get("snaktype", "value") != "value":
        return None
    return (snak.get("datavalue") or {}).get("value")


def _item(snak: Any) -> str | None:
    value = _value(snak)
    qid = value.get("id") if isinstance(value, dict) else None
    return qid if isinstance(qid, str) and _QID.match(qid) else None


def _string(snak: Any) -> str | None:
    value = _value(snak)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _statements(claims: dict, pid: str) -> list[dict]:
    rows = claims.get(pid) if isinstance(claims, dict) else None
    return [row for row in rows or [] if isinstance(row, dict) and row.get("rank") != "deprecated"]


def _ended(statement: dict) -> bool:
    qualifiers = statement.get("qualifiers") if isinstance(statement.get("qualifiers"), dict) else {}
    return bool(qualifiers.get("P582"))


def _text_map(block: Any) -> dict[str, str]:
    out = {}
    for lang in ("ko", "en"):
        entry = block.get(lang) if isinstance(block, dict) else None
        value = entry.get("value") if isinstance(entry, dict) else None
        if isinstance(value, str) and value.strip():
            out[lang] = value.strip()
    return out


def parse_search(payload: Any) -> list[dict]:
    """wbsearchentities → [{id, label, description}](라벨이 없으면 뺌)."""
    out = []
    rows = payload.get("search") if isinstance(payload, dict) else None
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or not _QID.match(str(row.get("id") or "")):
            continue
        label = row.get("label") if isinstance(row.get("label"), str) else None
        if not label or not label.strip():
            continue
        description = row.get("description") if isinstance(row.get("description"), str) else None
        out.append({"id": row["id"], "label": label.strip(), "description": (description or "").strip() or None})
    return out


def parse_cirrus(payload: Any) -> list[str]:
    """query&list=search → QID 목록(찾은 순서)."""
    rows = ((payload or {}).get("query") or {}).get("search") if isinstance(payload, dict) else None
    return [row["title"] for row in rows or [] if isinstance(row, dict) and _QID.match(str(row.get("title") or ""))]


def parse_entity(raw: Any) -> dict | None:
    """
    wbgetentities의 항목 하나 → 이름·별칭·설명·사람 여부·조직 근거·CIK·티커·관계. 없는 항목이면 None.
    ``tickers``는 거래소와 상관없이 모든 상장 티커(조직 근거로만 씀), ``us_tickers``·``kr_codes``는 미국·한국 거래소 문장의 티커,
    ``ciks``는 P5531 값 전부(10자리), ``cik``는 그 첫 값, ``lei``는 P1278 가운데 모양이 맞는 첫 값(없으면 None)입니다.
    """
    if not isinstance(raw, dict) or "missing" in raw or not _QID.match(str(raw.get("id") or "")):
        return None
    claims = raw.get("claims") if isinstance(raw.get("claims"), dict) else {}
    aliases: dict[str, list[str]] = {}
    for lang in ("ko", "en"):
        rows = (raw.get("aliases") or {}).get(lang) if isinstance(raw.get("aliases"), dict) else None
        aliases[lang] = [row["value"].strip() for row in rows or []
                         if isinstance(row, dict) and isinstance(row.get("value"), str) and row["value"].strip()]
    kinds = {_item(row.get("mainsnak")) for row in _statements(claims, "P31")}
    ciks: list[str] = []
    for row in _statements(claims, "P5531"):
        value = _string(row.get("mainsnak"))
        if value and value.isdigit() and len(value) <= 10 and value.zfill(10) not in ciks:
            ciks.append(value.zfill(10))
    listings: list[tuple[str | None, str]] = []
    for row in _statements(claims, "P414"):
        if _ended(row):
            continue
        exchange = _item(row.get("mainsnak"))
        for qualifier in ((row.get("qualifiers") or {}).get("P249") or []):
            ticker = _string(qualifier)
            if ticker and (exchange, ticker) not in listings:
                listings.append((exchange, ticker))
    tickers = list(dict.fromkeys(ticker for _, ticker in listings))
    lei = next((value for value in (_string(row.get("mainsnak")) for row in _statements(claims, "P1278"))
                if value and LEI.match(value)), None)
    relations: list[tuple[str, str]] = []
    for pid, relation in RELATION_PROPS.items():
        taken = 0
        for row in _statements(claims, pid):
            target = _item(row.get("mainsnak"))
            if target is None or _ended(row) or taken >= MAX_LINKS_PER_RELATION:
                continue
            if (relation, target) not in relations:
                relations.append((relation, target))
                taken += 1
    return {
        "id": raw["id"],
        "labels": _text_map(raw.get("labels")),
        "aliases": aliases,
        "descriptions": _text_map(raw.get("descriptions")),
        "human": HUMAN in kinds,
        "organization": bool(kinds & ORGANIZATION_TYPES) or any(_statements(claims, pid) for pid in ORGANIZATION_PROPS),
        "cik": ciks[0] if ciks else None,
        "ciks": ciks,
        "tickers": tickers,
        "us_tickers": list(dict.fromkeys(ticker for exchange, ticker in listings if exchange in US_EXCHANGES)),
        "kr_codes": list(dict.fromkeys(ticker for exchange, ticker in listings if exchange in KR_EXCHANGES)),
        "relations": relations,
        "lei": lei,
    }


def label_of(parsed_labels: dict[str, str]) -> str | None:
    return parsed_labels.get("ko") or parsed_labels.get("en")


# ------------------------------------------------------------------ 부르기

def search(text: str, lang: str, limit: int = 10) -> list[dict]:
    """이름 찾기 — 그 언어(ko·en)의 라벨·별칭에서."""
    return parse_search(api({"action": "wbsearchentities", "search": text, "language": lang, "uselang": lang,
                             "type": "item", "limit": str(limit)}))


def cirrus(query: str, limit: int = 20) -> list[str]:
    """CirrusSearch 질의 → QID 목록."""
    return parse_cirrus(api({"action": "query", "list": "search", "srsearch": query, "srnamespace": "0",
                             "srlimit": str(limit), "srprop": "", "srinfo": ""}))


def cirrus_text(text: str) -> str:
    """CirrusSearch 자유 검색어로 넣을 글 — 질의 문법 글자를 빈칸으로."""
    return " ".join(_CIRRUS_UNSAFE.sub(" ", text).split())


def get_entities(ids: Iterable[str], *, labels_only: bool = False) -> dict[str, dict]:
    """wbgetentities(ko·en만) → {QID: 읽은 항목}. 50개씩 나눠 부릅니다."""
    wanted = [qid for qid in dict.fromkeys(ids) if _QID.match(qid)]
    out: dict[str, dict] = {}
    for start in range(0, len(wanted), MAX_IDS):
        chunk = wanted[start:start + MAX_IDS]
        props = "labels" if labels_only else "labels|aliases|descriptions|claims"
        payload = api({"action": "wbgetentities", "ids": "|".join(chunk), "props": props, "languages": LANGUAGES})
        for qid, raw in ((payload or {}).get("entities") or {}).items():
            parsed = parse_entity(raw)
            if parsed is not None:
                out[qid] = parsed
    return out
