"""
app/services/sec_fundamentals.py
SEC XBRL Company Facts — 모의 매매 Claude 책 패킷의 미국 종목 재무(명세 D28, 설계 §4-5).

이 모듈은 "받아서 추린다"까지만 합니다. 시점(filed ≤ 기준일)·기간 분류·누계 차감·TTM·개념 선택은 백엔드
analytics.Fundamentals가 저장본을 읽어 합니다 — 수집기가 계산까지 하면 같은 공시를 두 곳이 다르게 해석할 수 있습니다.

[요청]
- 회사마다 ``data.sec.gov/api/xbrl/companyfacts/CIK##########.json`` 한 건(단계 0-b 측정: 평균 227KB 전송·0.35초).
  companyconcept(개념마다 한 건)·frames(그 시점 값이 아님)·일괄 zip(1.41GB)은 쓰지 않습니다.
- 13F와 같은 세션(get_sec_session — 연락처 UA)과 같은 토큰 버킷(sec_rate_limit)을 씁니다. 프로세스 전체 합계가 초당
  8건을 넘지 않습니다. UA 값(소유자 이메일)은 로그·오류 문구에 싣지 않습니다.
- 404는 'companyfacts 없음'(재무 XBRL을 내지 않는 신탁·일부 해외 발행사 — 측정에서 IBN)이라 실패가 아니라 답입니다.

[추출 — 설계 §4-5 ②]
- 개념: 설계 §4-5 ⑤ 후보 전부(``us-gaap``·``ifrs-full``·``dei``). 어느 후보를 쓸지는 백엔드가 고릅니다(가장 최근 end).
- 서식: 10-Q·10-K·20-F·40-F와 그 정정(/A). 6-K·8-K는 뺍니다(실적 보도자료는 XBRL 재무 사실이 아님).
- 범위: 연간(350~380일) 사실은 end ≥ 2020-01-01, 나머지(분기·누계·시점)는 end ≥ 2023-07-01.
- 기간은 start/end로만 봅니다. ``fy``·``fp``는 사실의 기간이 아니라 그 사실을 담은 **공시**의 회계연도·분기라(AAPL의
  2025-06-28 분기 매출이 fy 2025와 fy 2026 두 번 나옴) 참고용으로만 싣고, ``frame``은 가장 늦게 낸 값에만 붙어
  그 시점 값을 가리키지 못하므로 싣지 않습니다.

[중복]
같은 (taxonomy, concept, unit, start, end)는 처음 낸 값과, 그 뒤 **값이 바뀐** 행만 남깁니다. 측정에서 사실 수는 서로
다른 기간 수의 평균 2.07배였습니다 — 같은 기간이 그해 공시와 다음 해 비교 열에 거듭 나옵니다. 정정(/A)의 69%는
원본과 같은 값이라 버리고, 값이 다른 5%(재작성)는 남깁니다.
"""
from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass, field
from datetime import date

from ..http import SourceRejected, brief_error, get_sec_session, sec_rate_limit

logger = logging.getLogger(__name__)

COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
COMPANYFACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"

# (연결, 읽기) 초. 가장 큰 문서(은행 JPM 7.8MB JSON, gzip 530KB)도 측정에서 1.2초 안이었습니다. 읽기 상한은 넉넉히 두되,
# 세션 재시도(5회)와 곱해져 태스크 하나를 오래 붙잡지 않게 무한 대기는 두지 않습니다.
REQUEST_TIMEOUT = (10, 60)

# ==============================================================================
# CIK 별칭표 — 지주회사 재편으로 이력이 옛 CIK에 남은 곳 (수동, 소량)
# ==============================================================================
# company_tickers.json은 티커를 **지금** 상장된 법인의 CIK 하나로만 잇습니다. 지주회사를 새로 세워 상장 법인이 바뀐 곳은
# 새 CIK에 공시 몇 건뿐이고 이력은 옛 CIK에 있습니다(새 CIK submissions의 formerNames가 비어 자동으로는 잇지 못함).
# 목록의 첫 CIK가 지금 법인입니다. 두 CIK의 사실은 합치고, 같은 기간이면 위의 중복 규칙으로 하나만 남습니다.
#
# 넣는 기준: 새 CIK가 승계 발행인(8-K12B·8-K12G3)이고, 옛 CIK가 그 무렵 상장 폐지(25-NSE)·등록 말소(15-12G)됐으며,
# 겹치는 기간의 순이익이 **같은 값**인 곳만 — 같은 경제 실체라는 뜻입니다. 2026-10-25 수집기 컨테이너에서 SEC
# submissions·companyfacts로 확인했습니다(CIK ≥ 1,990,000인 매핑 9곳 전부 + 옛 CIK 후보 5곳).
#   XOM  0002115436 ExxonMobil Holdings Corp — 8-K12B 2026-07-01. 옛 0000034088 Exxon Mobil Corporation(25-NSE 2026-07-02,
#        10-Q 2026-05-04까지 XBRL). 겹치는 순이익 2/2 같음.
#   BLK  0002012383 BlackRock, Inc.(옛 이름 BlackRock Funding, Inc. → 2024-10-01 개명, 첫 10-Q 2024-11-06). 옛 0001364742
#        BlackRock Finance, Inc.(2024-09-26까지 이름 BlackRock Inc., 25-NSE 2024-10-02·15-12G 2024-10-15, 마지막 10-Q
#        2024-08-06). 겹치는 순이익 7/7 같음.
#   FERG 0002011641 Ferguson Enterprises Inc. /DE/ — 8-K12B 2024-08-01, 첫 10-K 2024-09-25. 옛 0001832433 Ferguson (Jersey)
#        Ltd(2024-06-20까지 이름 Ferguson plc, 25-NSE 2024-08-01·15-12G 2024-08-12, 마지막 10-Q 2024-06-05). 겹치는 순이익 7/7 같음.
# 넣지 않은 곳(같은 실체가 아님):
#   SW   Smurfit Westrock — 회계상 선행 실체는 Smurfit Kappa(SEC 공시 없음). 옛 WestRock(0001732845)은 인수된 쪽이라
#        겹치는 분기 순이익이 다름(2/2 다름).
#   PRMB Primo Brands — 8-K12G3로 Primo Water(0000884713)를 승계했지만 회계상 취득자는 BlueTriton이라 겹치는 기간이 없고
#        숫자가 다른 회사의 것.
#   GEV(GE에서 분사, Form 10)·CBRS·MDLN(신규 상장, S-1)·SUNB(Form 10)는 승계 서식이 없음 — 선행 등록 법인이 없습니다.
FUNDAMENTALS_CIK_ALIASES: dict[str, list[str]] = {
    "XOM": ["0002115436", "0000034088"],
    "BLK": ["0002012383", "0001364742"],
    "FERG": ["0002011641", "0001832433"],
}

# ==============================================================================
# 추출할 개념 — 설계 §4-5 ⑤의 후보 전부 (어느 것을 쓸지는 백엔드가 고름)
# ==============================================================================
CONCEPTS: dict[str, tuple[str, ...]] = {
    "us-gaap": (
        # 매출
        "Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenuesNetOfInterestExpense",
        # 순이익
        "NetIncomeLoss", "ProfitLoss",
        # 영업현금흐름
        "NetCashProvidedByUsedInOperatingActivities",
        # 설비투자
        "PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets",
        "PaymentsToAcquireOtherPropertyPlantAndEquipment", "PaymentsToAcquireRealEstate", "PaymentsToDevelopRealEstateAssets",
        # 자산·자본
        "Assets",
        "StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", "PartnersCapital",
        # 매출채권·재고
        "AccountsReceivableNetCurrent", "ReceivablesNetCurrent",
        "InventoryNet", "InventoryFinishedGoodsNetOfReserves",
        # 장기부채 — 유동분 포함 여부가 개념마다 달라 백엔드가 쓴 개념 이름을 함께 냅니다
        "LongTermDebt", "LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations",
        "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities", "DebtInstrumentCarryingAmount",
        # 자사주·배당
        "PaymentsForRepurchaseOfCommonStock", "PaymentsForRepurchaseOfEquity",
        "PaymentsOfDividends", "PaymentsOfDividendsCommonStock", "PaymentsOfOrdinaryDividends",
        "DistributionMadeToLimitedPartnerCashDistributionsPaid",
        # 주식수(dei가 없을 때) — 희석 가중평균은 대용치(isProxy)
        "CommonStockSharesOutstanding", "WeightedAverageNumberOfDilutedSharesOutstanding",
    ),
    "ifrs-full": (
        "Revenue",
        "ProfitLossAttributableToOwnersOfParent", "ProfitLoss",
        "CashFlowsFromUsedInOperatingActivities",
        "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
        "Assets",
        "EquityAttributableToOwnersOfParent", "Equity",
        "TradeAndOtherCurrentReceivables", "CurrentTradeReceivables",
        "Inventories",
        "LongtermBorrowings", "NoncurrentPortionOfNoncurrentBorrowings", "Borrowings",
        "PaymentsToAcquireOrRedeemEntitysShares",
        "DividendsPaidClassifiedAsFinancingActivities", "DividendsPaid",
        "AdjustedWeightedAverageShares",
    ),
    "dei": (
        # 표지의 발행 주식수 — 복수 주식 종류 회사(GOOGL·META·BRK-B 등)는 종류별(dimensional) 사실만 있어 빠집니다
        "EntityCommonStockSharesOutstanding",
    ),
}

FORMS = frozenset({"10-Q", "10-K", "20-F", "40-F", "10-Q/A", "10-K/A", "20-F/A", "40-F/A"})

# 연간 사실은 6~7회계연도(TTM의 1년 전 비교·3회계연도 표에 여유), 나머지는 약 13분기만. 측정: 회사당 약 26KB.
PERIOD_CUTOFF = "2023-07-01"
ANNUAL_CUTOFF = "2020-01-01"
# 52/53주 회계연도를 감안한 연간 길이(일). 백엔드 기간 분류(analytics.Fundamentals)와 같은 범위입니다.
ANNUAL_DAYS = (350, 380)

# 통화가 아닌 단위 — 상태 스냅샷의 currency를 고를 때 뺍니다(주식수·비율·주당 값).
_NON_MONETARY_UNITS = frozenset({"shares", "pure"})


class FetchError(RuntimeError):
    """SEC 요청이 실패했습니다(연결·시간 초과·재시도 뒤에도 4xx/5xx·JSON 아님). 메시지는 화면에 뜨는 한 줄입니다."""


@dataclass
class CompanyResult:
    """
    한 회사(CIK 여러 개를 합친 것)의 수집 결과.

    rows: 공시일(filed) → 그날 행의 payload ``{"cik": [...], "facts": [...]}``
    error: 실패 사유(실패면 rows는 비어 있고 저장하지 않음). ``no_companyfacts``면 모든 CIK가 404 — 실패가 아니라 답입니다.
    requests: 이번에 보낸 companyfacts 요청 수(예산 계산용)
    """
    ciks: list[str]
    rows: dict[str, dict] = field(default_factory=dict)
    summary: dict = field(default_factory=dict)
    error: str | None = None
    no_companyfacts: bool = False
    requests: int = 0


# ==============================================================================
# 티커 → CIK
# ==============================================================================
def fetch_company_tickers(session=None) -> dict[str, str]:
    """
    SEC ``company_tickers.json``(약 1만 행·800KB) → {티커(대문자): CIK 10자리}. 실행마다 한 번 받습니다.

    같은 티커가 여러 행이면 앞의 것을 씁니다. 측정에서 유니버스 571종목이 전부 그대로 일치했습니다 —
    SEC도 ``BRK-B``·``BF-B``처럼 야후와 같은 '-' 표기를 씁니다.

    :raises FetchError: 받지 못했거나 모양이 다를 때
    """
    data = _get_json(session or get_sec_session(), COMPANY_TICKERS_URL)
    if data is None or not isinstance(data, dict):
        raise FetchError("company_tickers.json 모양이 예상과 다릅니다")
    mapping: dict[str, str] = {}
    for row in data.values():
        if not isinstance(row, dict):
            continue
        ticker = str(row.get("ticker") or "").strip().upper()
        cik = row.get("cik_str")
        if ticker and cik is not None and str(cik).isdigit():
            mapping.setdefault(ticker, str(cik).zfill(10))
    if not mapping:
        raise FetchError("company_tickers.json에 티커가 없습니다")
    return mapping


def resolve_ciks(ticker: str, mapping: dict[str, str]) -> list[str]:
    """
    그 티커의 CIK 목록(지금 법인이 앞). 별칭표에 있으면 매핑된 CIK 뒤에 별칭의 CIK를 잇고, 없으면 매핑 CIK 하나.
    매핑에 없고 별칭표에만 있으면 별칭표 그대로. 둘 다 없으면 빈 목록(SEC 공시가 없는 장외 해외주·ETF 등).
    """
    found = mapping.get(ticker.upper())
    aliases = FUNDAMENTALS_CIK_ALIASES.get(ticker.upper(), [])
    ordered = ([found] if found else []) + list(aliases)
    return list(dict.fromkeys(ordered))


# ==============================================================================
# companyfacts 받기
# ==============================================================================
def fetch_companyfacts(cik: str, session=None) -> dict | None:
    """
    한 CIK의 companyfacts 문서. 404면 None(재무 XBRL 없음).

    :raises FetchError: 그 밖의 실패
    """
    return _get_json(session or get_sec_session(), COMPANYFACTS_URL.format(cik=str(cik).zfill(10)), allow_404=True)


# 403은 대개 연락처 없는 User-Agent입니다(SEC 정책). 값 자체는 싣지 않습니다.
_UA_HINT = " — SEC_USER_AGENT에 본인 이메일을 넣으세요"


def _get_json(session, url: str, *, allow_404: bool = False):
    try:
        sec_rate_limit()
        res = session.get(url, timeout=REQUEST_TIMEOUT)
    except SourceRejected as exc:
        # SEC 세션의 어댑터가 403·429를 출처 거부로 올립니다(http.py). 연결 실패가 아니고, 메시지가 이미 화면용 한 줄(거부됨 — …)이라
        # 앞머리 없이 적고 403이면 UA 안내를 붙입니다.
        raise FetchError(f"{exc}{_UA_HINT if exc.why == 'HTTP 403' else ''}") from exc
    except Exception as exc:  # noqa: BLE001 — 연결 오류의 종류와 관계없이 그 회사 하나의 실패로 기록합니다
        raise FetchError(f"SEC 연결 실패: {brief_error(exc)}") from exc
    status = getattr(res, "status_code", 200)
    if allow_404 and status == 404:
        return None
    if status >= 400:
        raise FetchError(f"SEC 응답 {status}{_UA_HINT if status == 403 else ''}")
    try:
        return res.json()
    except ValueError as exc:
        raise FetchError(f"SEC 응답이 JSON이 아닙니다: {brief_error(exc)}") from exc


# ==============================================================================
# 추출·중복 제거·공시일 묶기 (네트워크 없음 — 테스트가 문서를 직접 넣습니다)
# ==============================================================================
def _days(start: str, end: str) -> int | None:
    try:
        return (date.fromisoformat(end) - date.fromisoformat(start)).days
    except (TypeError, ValueError):
        return None


def _is_date(text) -> bool:
    if not isinstance(text, str):
        return False
    try:
        date.fromisoformat(text)
    except ValueError:
        return False
    return True


def is_annual(start: str | None, end: str) -> bool:
    """기간 사실이 연간(350~380일)인가. 시점 사실(start 없음)은 아닙니다."""
    if not start:
        return False
    length = _days(start, end)
    return length is not None and ANNUAL_DAYS[0] <= length <= ANNUAL_DAYS[1]


def extract_facts(doc: dict, cik: str | None = None) -> list[dict]:
    """
    companyfacts 문서 → 필요한 사실만 압축한 목록(중복 제거 전).

    한 사실 = ``{"t","c","u","s","e","v","f","a","fy","fp","filed","cik"}`` — ``filed``·``cik``는 저장 행을 묶는 데만 쓰고
    payload의 사실에는 넣지 않습니다(행의 obs_date가 filed, 행의 ``cik`` 목록이 출처).
    값(val)이 없거나 숫자가 아닌 사실, 날짜를 읽을 수 없는 사실은 버립니다 — 0으로 채우지 않습니다.
    """
    out: list[dict] = []
    taxonomies = (doc or {}).get("facts") or {}
    for taxonomy, concepts in CONCEPTS.items():
        node = taxonomies.get(taxonomy) or {}
        for concept in concepts:
            units = (node.get(concept) or {}).get("units") or {}
            for unit, rows in units.items():
                for row in rows or []:
                    fact = _compact(taxonomy, concept, unit, row, cik)
                    if fact is not None:
                        out.append(fact)
    return out


def _compact(taxonomy: str, concept: str, unit: str, row: dict, cik: str | None) -> dict | None:
    if not isinstance(row, dict) or row.get("form") not in FORMS:
        return None
    end, filed, start, value = row.get("end"), row.get("filed"), row.get("start"), row.get("val")
    if not _is_date(end) or not _is_date(filed) or (start is not None and not _is_date(start)):
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    cutoff = ANNUAL_CUTOFF if is_annual(start, end) else PERIOD_CUTOFF
    if end < cutoff:
        return None
    return {
        "t": taxonomy, "c": concept, "u": unit, "s": start or None, "e": end, "v": value,
        "f": row.get("form"), "a": row.get("accn"), "fy": row.get("fy"), "fp": row.get("fp"),
        "filed": filed, "cik": cik,
    }


def _key(fact: dict) -> tuple:
    return fact["t"], fact["c"], fact["u"], fact["s"] or "", fact["e"]


def _is_amendment(form) -> bool:
    """정정 공시(10-Q/A 등)인가 — 같은 날이면 원본 뒤에 낸 것으로 봅니다."""
    return isinstance(form, str) and form.endswith("/A")


def dedup_facts(facts: list[dict]) -> list[dict]:
    """
    같은 (t, c, u, s, e)마다 처음 낸 값과, 그 뒤 직전에 남긴 값과 **다른** 값만 남깁니다(공시일 순).

    같은 공시일에 같은 키의 값이 둘 이상이면(원본과 정정을 같은 날 냄 등) 그날 **정정(/A)이 있으면 정정, 그다음 접수 번호(accn)
    순**으로 마지막 것만 남깁니다 — 공시일 단위로 시점을 판정하는 백엔드가 "그날 알려진 값"을 하나로 고를 수 있게(백엔드
    Fundamentals.LATER와 같은 순서). 접수 번호 앞 10자리는 제출자(대행사)의 CIK라 대행사가 다른 두 접수 사이에서는 사전순이 접수
    순서가 아닙니다 — accn만으로 고르면 같은 날 낸 정정 값을 버려, 백엔드의 /A 우선 규칙이 쓸 사실이 남지 않았습니다. 그 결과가
    전날까지 남긴 값과 같으면 그날 행에서 뺍니다(값이 바뀌지 않음).
    """
    ordered = sorted(enumerate(facts), key=lambda item: (
        item[1]["filed"], _is_amendment(item[1].get("f")), item[1]["a"] or "", item[0]))
    kept: dict[tuple, list[dict]] = {}
    for _index, fact in ordered:
        history = kept.setdefault(_key(fact), [])
        if not history:
            history.append(fact)
            continue
        last = history[-1]
        if last["filed"] == fact["filed"]:
            if last["v"] == fact["v"]:
                continue
            history[-1] = fact
            if len(history) >= 2 and history[-2]["v"] == fact["v"]:
                history.pop()
            continue
        if last["v"] != fact["v"]:
            history.append(fact)
    survivors = [fact for history in kept.values() for fact in history]
    return sorted(survivors, key=lambda f: (f["filed"], *_key(f), f["a"] or ""))


def group_by_filed(facts: list[dict], ciks: list[str]) -> dict[str, dict]:
    """
    중복을 지운 사실 → {공시일: payload}. payload = ``{"cik": [그날 사실을 낸 CIK…], "facts": [...]}``.

    같은 날 공시가 둘이면(10-Q와 정정, 별칭 두 CIK) 한 행에 합칩니다. 사실은 (t, c, u, s, e, a) 순 — 같은 입력이면 같은
    payload라 upsert가 바뀌지 않은 행을 다시 쓰지 않습니다(store의 IS DISTINCT FROM).
    """
    order = {cik: i for i, cik in enumerate(ciks)}
    grouped: dict[str, list[dict]] = {}
    for fact in facts:
        grouped.setdefault(fact["filed"], []).append(fact)
    rows: dict[str, dict] = {}
    for filed in sorted(grouped):
        day = sorted(grouped[filed], key=lambda f: (*_key(f), f["a"] or ""))
        sources = sorted({f["cik"] for f in day if f.get("cik")}, key=lambda c: order.get(c, len(order)))
        rows[filed] = {
            "cik": sources,
            "facts": [{k: f[k] for k in ("t", "c", "u", "s", "e", "v", "f", "a", "fy", "fp")} for f in day],
        }
    return rows


def summarize(facts: list[dict]) -> dict:
    """
    상태 스냅샷 한 줄의 요약: latestFiled·latestEnd·latestAnnualEnd·taxonomy·currency·facts(남긴 사실 수).

    latestEnd·latestAnnualEnd는 재무제표 사실(us-gaap·ifrs-full)에서만 봅니다 — dei 주식수의 end는 표지 기준일(기간 끝보다
    뒤)이라 섞으면 '새 공시가 나올 때'를 늦게 잡습니다. taxonomy는 최신 end가 늦은 쪽(같으면 사실이 많은 쪽), currency는
    그 분류체계의 통화 단위 중 가장 많은 것. 해당 사실이 없으면 None(0이나 빈 문자열로 채우지 않음).
    """
    statements = [f for f in facts if f["t"] != "dei"]
    by_taxonomy: dict[str, list[dict]] = {}
    for fact in statements:
        by_taxonomy.setdefault(fact["t"], []).append(fact)
    taxonomy = None
    if by_taxonomy:
        taxonomy = max(by_taxonomy, key=lambda t: (max(f["e"] for f in by_taxonomy[t]), len(by_taxonomy[t]), t))
    currencies = Counter(
        f["u"] for f in by_taxonomy.get(taxonomy, []) if f["u"] not in _NON_MONETARY_UNITS and "/" not in f["u"]
    )
    currency = min(currencies, key=lambda u: (-currencies[u], u)) if currencies else None
    annual_ends = [f["e"] for f in statements if is_annual(f["s"], f["e"])]
    return {
        "latestFiled": max((f["filed"] for f in facts), default=None),
        "latestEnd": max((f["e"] for f in statements), default=None),
        "latestAnnualEnd": max(annual_ends, default=None),
        "taxonomy": taxonomy,
        "currency": currency,
        "facts": len(facts),
    }


# ==============================================================================
# 한 회사 수집
# ==============================================================================
def collect_company(ciks: list[str], session=None) -> CompanyResult:
    """
    CIK 목록(별칭 포함)의 companyfacts를 차례로 받아 합치고 → 중복 제거 → 공시일 행.

    한 CIK라도 404가 아닌 실패면 그 회사 전체를 실패로 둡니다(저장하지 않음) — 일부 CIK만으로 행을 다시 쓰면, 옛 CIK의
    사실이 빠진 채 새 CIK의 비교 열이 '처음 낸 값'이 되어 같은 날 행의 내용이 바뀝니다. 모든 CIK가 404면 no_companyfacts.
    문서는 한 번에 하나만 메모리에 둡니다(가장 큰 것이 JSON 약 8MB — 수집기 메모리 상한 1g).
    """
    result = CompanyResult(ciks=list(ciks))
    session = session or get_sec_session()
    merged: list[dict] = []
    answered = 0
    for cik in ciks:
        result.requests += 1
        try:
            doc = fetch_companyfacts(cik, session)
        except FetchError as exc:
            result.error = f"{cik} {exc}"
            return result
        if doc is None:
            continue
        answered += 1
        merged.extend(extract_facts(doc, cik))
        del doc
    if not answered:
        result.error = "no companyfacts"
        result.no_companyfacts = True
        return result
    facts = dedup_facts(merged)
    result.rows = group_by_filed(facts, list(ciks))
    result.summary = summarize(facts)
    return result
