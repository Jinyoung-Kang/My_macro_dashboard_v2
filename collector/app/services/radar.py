"""
app/services/radar.py
국내 수급 레이더 — 무중단(fail-safe) 폴백 체인.

    KIS(장중 가집계) → Daum(API) → Naver(stock.naver.com API, 확정 값만) → KRX(정보데이터시스템 저장본, 확정) → 토스(공식) → 누적 이력

앞쪽이 성공하면 뒤는 호출되지 않습니다.

[반드시 알아야 할 제약]
- Naver·Daum·KIS는 **과거 날짜 조회를 지원하지 않습니다.** "가장 최근에 끝난
  거래일"만 줍니다. 과거 조회를 하던 PyKrx(KRX 웹을 비공식으로 긁는 라이브러리)와
  LS증권 OPEN API는 2026-11-11에 뺐습니다(ADR 0035).
- 2026-11-11부터 KRX 정보데이터시스템(로그인 — ADR 0036)의 확정 순위를 수집기가 거래일 저녁마다 저장하고(외부 호출 없이 그 저장본만
  읽음), 과거 날짜·여섯 투자주체의 확정 순위는 먼저 거기서 찾습니다.
- 그것도 없으면 **수집기가 쌓아 온 우리 자신의 이력**
  (observations)에서 가장 가까운 이전 거래일 랭킹을 꺼내 씁니다. 이 경우
  source에 "어느 날짜의 저장본인지"를 반드시 적어, 화면이 "지금 시점의
  수급이 아니다"라고 경고할 수 있게 합니다.
- 즉 **수집기를 꾸준히 돌리는 것이 곧 백업입니다.**

[종목코드는 항상 문자열]
"069500"을 숫자로 다루면 앞자리 0이 사라져 69500이 되고, 이후 모든 조회가
실패합니다. 이 파일은 코드를 문자열로만 다룹니다.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from ..numbers import to_float, to_int
from .. import catalog, krcalendar, kst, store
from ..http import get_session
from . import kis, toss

logger = logging.getLogger(__name__)

KST = ZoneInfo("Asia/Seoul")

DAUM_RANKING_URL = "https://finance.daum.net/api/trend/investor_purchase/"
# 마지막 Naver 수집이 왜 비었는지. 진단 화면이 "빈 결과입니다"에서 끝나지
# 않도록, 실패한 단계를 그대로 들고 있습니다.
_NAVER_LAST_REASON: dict[str, str | None] = {"value": None}
_TOSS_LAST_REASON: dict[str, str | None] = {"value": None}

# 네이버 증권 새 화면(stock.naver.com/market/stock/kr/trend/foreigner·organization)이 표를 채우는 JSON API (ADR 0035 결정 10).
# 옛 iframe 페이지(finance.naver.com/sise/sise_deal_rank_iframe.naver)는 HTTP 410으로 끊겼습니다.
NAVER_RANKING_URL = "https://stock.naver.com/api/domestic/market/trend/trendForeignOrg"
NAVER_REFERERS = {
    "FOREIGNER": "https://stock.naver.com/market/stock/kr/trend/foreigner",
    "ORGANIZATION": "https://stock.naver.com/market/stock/kr/trend/organization",
}
# 화면이 한 번에 받는 행 수(무한 스크롤 한 쪽). 상위 N이 이보다 크면 다음 쪽(startIdx=1)을 한 번 더 받습니다.
NAVER_PAGE_SIZE = 20
NAVER_MAX_PAGES = 2
# 새 API는 외국인·기관만 줍니다. 나머지 넷은 토스(거래대금 상위 안의 순위)로 넘어갑니다.
NAVER_INVESTOR_TYPES = {"외국인": "FOREIGNER", "기관": "ORGANIZATION"}

DAUM_INVESTOR_TYPES = {"외국인": "FOREIGN", "기관": "INSTITUTION"}

# 레이더가 받는 투자주체(화면 목록 순서). 지금 받을 수 있는 출처는 투자주체마다 다릅니다(diagnose_sources).
RADAR_INVESTORS = ("외국인", "기관", "개인", "연기금", "금융투자", "투신")

INTERVAL_LABELS = {"TODAY": "당일", "DAYS_5": "5거래일", "DAYS_20": "20거래일"}

# 받는 조건(백엔드 RadarService.INVESTORS·TRADE_TYPES·INTERVALS와 같음). 모르는 값을 받으면 예전 PyKrx 단계가 외국인·순매도로
# 바꿔 받아 그 결과를 임의 이름의 저장본·이력에 썼습니다(QA-037).
RADAR_TRADE_TYPES = ("순매수", "순매도")

# ==============================================================================
# 1. 거래일 계산 — app/krcalendar.py가 공휴일까지 보고 판정합니다. 이름은 호환을 위해 남깁니다.
# ==============================================================================
def latest_completed_session(now: datetime | None = None) -> str:
    """지금 이 시점에 Naver/Daum이 '현재 데이터'로 보여주는 거래일(YYYYMMDD)."""
    return krcalendar.latest_completed_session(now)


def is_regular_session(now: datetime | None = None) -> bool:
    return krcalendar.is_regular_session(now)


# ==============================================================================
# 2. 폴백 체인
# ==============================================================================
def collect_radar_ranking(
    target_day: date,
    market: str = "KOSPI",
    investor: str = "외국인",
    trade_type: str = "순매수",
    top_n: int = 30,
    interval_type: str = "TODAY",
) -> dict:
    """
    수급 랭킹을 수집합니다.

    반환 계약(JSON):
    {
      "source": "KIS 장중 가집계 / ...",   # 어느 출처가 실제로 성공했는지
      "sourceKind": "kis|daum|naver|krx|toss|history|none",
      "isHistorical": bool,                # 누적 이력 대체 여부 (화면 경고용)
      "rows": [{"rank","code","name","price","changePct","netAmountEok",...}]
    }
    """
    now = datetime.now(KST)
    today_str = now.strftime("%Y%m%d")
    latest_str = latest_completed_session(now)
    live = is_regular_session(now)

    if interval_type != "TODAY":
        rows = fetch_daum_ranking(
            target_day.strftime("%Y%m%d"), market, investor, trade_type,
            top_n, interval_type,
        )
        if rows:
            # 기관은 Daum이 당일만 주므로 실제로 받은 기간을 밝힙니다(QA-028).
            return _result(rows, "daum", daum_interval(investor, interval_type))
        logger.warning(
            "Daum 기간별(%s) 조회 실패. 당일 데이터로 자동 전환합니다.", interval_type
        )

    cursor = target_day
    for _ in range(7):     # 최대 7영업일을 거슬러 올라갑니다
        date_str = cursor.strftime("%Y%m%d")
        is_today = date_str == today_str
        can_use_current_only_sources = (
            is_today or date_str == latest_str
        )

        if is_today and live:
            rows = kis.fetch_deal_ranking(date_str, market, investor, trade_type, top_n)
            if rows:
                return _result(rows, "kis")

        if can_use_current_only_sources:
            rows = fetch_daum_ranking(
                date_str, market, investor, trade_type, top_n, "TODAY"
            )
            if rows:
                return _result(rows, "daum")

            rows = fetch_naver_ranking(date_str, market, investor, trade_type, top_n)
            if rows:
                return _result(rows, "naver")

            # KRX 확정 순위(저장본) — 그 날짜가 아직 없으면 가장 가까운 앞 거래일(전 종목·확정). 토스(거래대금 상위 100종목 안·추정)보다 앞.
            rows = fetch_krx_stored_ranking(date_str, market, investor, trade_type, top_n, nearest=True)
            if rows:
                return _result(rows, "krx")

            # 토스는 투자자별 순위 API가 없어 "거래대금 상위 100종목 안의 순위"입니다.
            # 시장 전체 순위를 주는 앞 단계가 모두 실패했을 때만 씁니다(저장본만 읽음, 호출 없음).
            rows = fetch_toss_ranking(market, investor, trade_type, top_n)
            if rows:
                return _result(rows, "toss")
        else:
            # 과거 날짜 — KRX 확정 순위 저장본(그 날짜 그대로)만 봅니다. 없으면 하루 앞으로.
            rows = fetch_krx_stored_ranking(date_str, market, investor, trade_type, top_n, nearest=False)
            if rows:
                return _result(rows, "krx")

        cursor -= timedelta(days=1)

    history = read_from_history(
        target_day, market, investor, trade_type, top_n, interval_type
    )
    if history:
        logger.info(
            "수급 레이더: 외부 소스가 모두 실패해 누적 이력으로 대체합니다 (%s행)",
            len(history["rows"]),
        )
        return {**history, "intervalType": interval_type}

    reasons = diagnose_sources(investor)
    logger.error(
        "수급 레이더 완전 실패: 날짜=%s, 시장=%s, 투자주체=%s, 방향=%s "
        "(누적 이력에도 없음) — %s",
        target_day, market, investor, trade_type,
        " / ".join(reasons) or "사유 불명",
    )
    return {
        "source": None,
        "sourceKind": "none",
        "isHistorical": False,
        "intervalType": interval_type,
        "rows": [],
        # 왜 실패했는지 화면까지 전달합니다.
        #
        # 예전에는 화면에 "수급 데이터를 얻지 못했습니다. 수집기 상태를
        # 확인하세요."만 떴습니다. 수집기는 멀쩡한데(다른 조합은 잘 나옴)
        # 그쪽을 보게 만들어, 실제 원인(소스별 제약·차단)에서 멀어졌습니다.
        "reasons": reasons,
    }


def _object_particle(word: str) -> str:
    """
    '을/를'을 고릅니다.

    화면에 그대로 나가는 문장입니다. "'개인'를 제공하지 않습니다"처럼 조사가
    틀리면, 읽는 사람은 문장이 아니라 그 어색함을 먼저 봅니다.
    한글 음절은 (코드포인트 - 0xAC00) % 28 로 받침 유무를 알 수 있습니다.
    """
    if not word:
        return "를"
    last = word[-1]
    if not ("가" <= last <= "힣"):
        return "를"
    has_final_consonant = (ord(last) - 0xAC00) % 28 != 0
    return "을" if has_final_consonant else "를"


def diagnose_sources(investor: str) -> list[str]:
    """
    폴백 체인이 전부 실패했을 때, 소스별로 '왜 못 줬는지'를 사람 말로 적습니다.

    호출 하나하나를 추적하는 대신 지금 상태를 보고 판정합니다. 실패 원인이
    대개 '이 소스는 이 투자주체를 원래 안 준다', '키가 없다', '서비스가
    없어졌다'처럼 **호출해 보지 않아도 아는 것**이기 때문입니다.
    """
    reasons: list[str] = []

    kis_reason = kis.unsupported_reason(investor)
    if kis_reason:
        reasons.append(kis_reason)

    if investor not in DAUM_INVESTOR_TYPES:
        reasons.append(
            f"Daum은 '{investor}'{_object_particle(investor)} 제공하지 않습니다 "
            "(외국인·기관만)"
        )

    if investor not in NAVER_INVESTOR_TYPES:
        reasons.append(
            f"Naver는 '{investor}'{_object_particle(investor)} 제공하지 않습니다 (외국인·기관만)"
        )
    elif _NAVER_LAST_REASON["value"]:
        reasons.append(f"Naver: {_NAVER_LAST_REASON['value']}")
    reasons.append("KRX 확정 순위 저장본이 그 날짜(또는 앞 7일)에 없습니다 — 수집기 info_krx_daily(운영 서버, 거래일 18:30 뒤)")

    toss_reason = _TOSS_LAST_REASON["value"]
    if toss_reason:
        reasons.append(f"토스: {toss_reason}")

    return reasons


def _result(rows: list[dict], kind: str, interval_type: str = "TODAY") -> dict:
    """
    ``intervalType``은 **실제로 받은** 기간입니다. 기간(5일·20일) 요청이 당일 데이터로 바뀌었으면 TODAY —
    저장하는 쪽이 요청한 기간 이름에 당일 금액을 쌓지 않게 합니다(QA-028).
    """
    return {
        "source": rows[0].get("source") if rows else None,
        "sourceKind": kind,
        "isHistorical": False,
        "intervalType": interval_type,
        "rows": rows,
    }


def daum_interval(investor: str, interval_type: str) -> str:
    """Daum이 실제로 주는 기간. 모르는 기간과 기관합계의 기간 누적(검증되지 않은 응답)은 당일입니다."""
    if interval_type not in INTERVAL_LABELS:
        return "TODAY"
    if investor == "기관" and interval_type != "TODAY":
        return "TODAY"
    return interval_type


# ==============================================================================
# 3. 개별 소스
# ==============================================================================
def fetch_daum_ranking(
    target_date: str,
    market: str,
    investor: str,
    trade_type: str,
    top_n: int,
    interval_type: str = "TODAY",
) -> list[dict]:
    """
    Daum 금융 investor_purchase API (시장 전체 Top N).

    주의: 기관합계의 기간별 누적(5일/20일) 응답은 검증되지 않았습니다. 잘못된
    기간 값을 보여주지 않도록 기관은 당일만 허용합니다.
    """
    investor_type = DAUM_INVESTOR_TYPES.get(investor)
    if investor_type is None:
        logger.warning("Daum 미지원 투자주체: %s (지원: 외국인, 기관)", investor)
        return []

    effective = daum_interval(investor, interval_type)
    if investor == "기관" and effective != interval_type:
        logger.warning("Daum 기관합계는 당일만 지원합니다. TODAY로 전환합니다.")
    interval_type = effective

    market_param = "KOSPI" if ("KOSPI" in market.upper() or "코스피" in market) else "KOSDAQ"

    params = {
        "buyFieldName": "straightPurchasePrice",
        "buyOrder": "desc",
        "sellFieldName": "straightPurchasePrice",
        "sellOrder": "asc",
        "limit": top_n,
        "market": market_param,
        "investorType": investor_type,
    }
    if interval_type != "TODAY":
        params["intervalType"] = interval_type

    headers = {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Referer": (
            "https://finance.daum.net/domestic/influential_investors"
            f"?market={market_param}"
        ),
        "X-Requested-With": "XMLHttpRequest",
    }

    try:
        res = get_session().get(
            DAUM_RANKING_URL, headers=headers, params=params, timeout=10
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Daum 랭킹 통신 실패 (%s/%s): %s", market_param, investor, exc)
        return []

    if res.status_code != 200:
        logger.warning("Daum 랭킹 HTTP 실패: %s", res.status_code)
        return []

    try:
        payload = res.json()
    except ValueError as exc:
        logger.warning("Daum 랭킹 JSON 해석 실패: %s", exc)
        return []

    records = parse_daum_ranking(
        payload, investor=investor, trade_type=trade_type, top_n=top_n,
        target_date=target_date, interval_type=interval_type,
    )
    if not records:
        logger.warning(
            "Daum 랭킹 빈 결과: market=%s, investor=%s, direction=%s, interval=%s",
            market_param, investor, trade_type, interval_type,
        )
    return records


def parse_daum_ranking(
    payload: dict,
    *,
    investor: str,
    trade_type: str,
    top_n: int,
    target_date: str,
    interval_type: str = "TODAY",
) -> list[dict]:
    """
    Daum investor_purchase 응답(JSON)을 랭킹 행으로. 네트워크를 모르는 순수 변환입니다.

    - symbolCode "A005930" → "005930" (문자열 유지)
    - changeRate는 0.0238 = 2.38% 형태의 소수 비율 → %로
    - straightPurchasePrice(원) → 억 원. 응답 부호가 방향과 어긋나면 방향에 맞춥니다
    - dataDate: 소스가 밝힌 데이터 기준일(toDate). 이력에 쌓을 때 추정 거래일보다 우선.
      toDate가 없으면 None — 요청한 날짜로 메우지 않습니다
    """
    if not isinstance(payload, dict):
        return []
    data = payload.get("data") or {}
    rows = data.get("BUY" if trade_type == "순매수" else "SELL") or []
    if not rows:
        return []

    from_date = payload.get("fromDate") or ""
    to_date = payload.get("toDate") or target_date
    period = (
        to_date if interval_type == "TODAY"
        else (f"{from_date}~{to_date}" if from_date and to_date else target_date)
    )
    source = (
        f"Daum API ({investor}, {INTERVAL_LABELS.get(interval_type, interval_type)}, {period})"
    )
    collected_at = kst.stamp()

    records: list[dict] = []
    for row in rows[:top_n]:
        if not isinstance(row, dict):
            continue

        raw_code = str(row.get("symbolCode", "")).strip()
        code = raw_code[1:] if raw_code.startswith("A") else raw_code
        name = str(row.get("name", "")).strip()
        if not code or not name:
            continue

        # 빠진 값은 모르는 값입니다. 0.0으로 적으면 '가격 0원·등락률 0%'가 이력에 영구히 남습니다.
        price = to_float(row.get("tradePrice"))
        change_rate = to_float(row.get("changeRate"))
        change_pct = None if change_rate is None else round(change_rate * 100.0, 2)
        net_won = to_float(row.get("straightPurchasePrice"))
        if net_won is None:
            continue    # 순매수 금액을 모르면 순위를 매길 수 없습니다
        net_eok = round(net_won / 100_000_000.0, 1)

        if trade_type == "순매도" and net_eok > 0:
            net_eok = -abs(net_eok)
        if trade_type == "순매수" and net_eok < 0:
            net_eok = abs(net_eok)

        records.append({
            "code": code,
            "name": name,
            "price": price,
            "changePct": change_pct,
            "netAmountEok": net_eok,
            "source": source,
            "collectedAt": collected_at,
            # 기준일은 소스가 밝힌 toDate만 씁니다. 없으면 모르는 것이고, 이력 누적이 달력으로 정합니다
            # (ADR 0005). 요청한 날짜를 적으면 장 시작 전 조회의 어제 데이터가 오늘 날짜로 쌓입니다.
            "dataDate": _iso_date(payload.get("toDate")) if interval_type == "TODAY" else None,
        })

    return _rank(records, trade_type, top_n)


def fetch_naver_ranking(
    target_date: str,
    market: str,
    investor: str,
    trade_type: str,
    top_n: int,
) -> list[dict]:
    """
    Naver 투자자별 매매상위 — stock.naver.com 새 화면이 부르는 ``trendForeignOrg`` API(외국인·기관, 당일, KRX 시장).

    주의: "가장 최근 거래일"의 순위만 줍니다. 과거 날짜 조회에 쓰면 안 됩니다(호출부가 그 조건을 지킵니다).
    장중·마감 직후의 순위는 추정(``estimated``)이라 순매수 금액이 오지 않습니다(주식 수만) — 그때는 행을 만들지 않고
    다음 단계로 넘깁니다. 확정 값이 오면 금액(원)을 억 원으로 씁니다(ADR 0035 결정 10).
    """
    investor_type = NAVER_INVESTOR_TYPES.get(investor)
    if investor_type is None:
        _NAVER_LAST_REASON["value"] = (
            f"'{investor}'{_object_particle(investor)} 제공하지 않습니다 (외국인·기관만)"
        )
        return []

    params = {
        "investorType": investor_type,
        "tradeType": "KRX",
        "marketType": "KOSPI" if ("KOSPI" in market.upper() or "코스피" in market) else "KOSDAQ",
        "startIdx": 0,
        "pageSize": NAVER_PAGE_SIZE,
        "periodType": "DAY",
    }
    pages: list[dict] = []
    for page in range(NAVER_MAX_PAGES):
        params["startIdx"] = page
        try:
            res = get_session().get(
                NAVER_RANKING_URL,
                params=params,
                # 화면이 보내는 문맥 그대로 — 그 화면에서 부른 요청처럼.
                headers={"Referer": NAVER_REFERERS[investor_type], "Accept": "application/json"},
                timeout=10,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Naver 랭킹 수집 실패: %s", exc)
            _NAVER_LAST_REASON["value"] = f"{type(exc).__name__}: {str(exc)[:120]}"
            return []
        if res.status_code != 200:
            _NAVER_LAST_REASON["value"] = f"HTTP {res.status_code}"
            return []
        try:
            payload = res.json()
        except ValueError:
            _NAVER_LAST_REASON["value"] = "JSON이 아닌 응답 (차단 페이지이거나 API 형식이 바뀐 경우)"
            return []
        pages.append(payload)
        listed = _naver_rank_list(payload, trade_type)
        if listed is None or len(listed) < NAVER_PAGE_SIZE or NAVER_PAGE_SIZE * (page + 1) >= top_n:
            break

    records, reason = parse_naver_ranking(pages, trade_type=trade_type, top_n=top_n, investor=investor)
    _NAVER_LAST_REASON["value"] = reason
    return records


def _naver_rank_list(payload, trade_type: str) -> list | None:
    """응답 한 쪽에서 방향에 맞는 순위 목록. 모양이 다르면 None."""
    if not isinstance(payload, dict) or not isinstance(payload.get("sections"), dict):
        return None
    listed = payload["sections"].get("buyRankList" if trade_type == "순매수" else "sellRankList")
    return listed if isinstance(listed, list) else None


def parse_naver_ranking(
    pages: list[dict], *, trade_type: str, top_n: int, investor: str,
) -> tuple[list[dict], str | None]:
    """
    ``trendForeignOrg`` 응답(쪽 여러 개)을 랭킹 행으로. 네트워크를 모르는 순수 변환입니다.

    - 추정 값(``estimated: true``)은 쓰지 않습니다 — 순매수 금액 칸이 ``"0"``(주지 않음)이라 0으로 읽으면 없는 숫자가 됩니다
    - 금액(``accTradeAmount``, 원)이 없거나 0인 행은 뺍니다(순위를 매길 수 없음). 가격·등락률이 비면 모르는 값(None)
    - 기준일은 출처가 밝힌 ``bizdateTo``입니다

    :returns: (행, 비어 있을 때의 사유). 행이 있으면 사유는 None
    """
    rows: list[dict] = []
    for payload in pages:
        listed = _naver_rank_list(payload, trade_type)
        if listed is None:
            return [], "응답 모양이 다릅니다 (sections.buyRankList·sellRankList 없음 — API 형식이 바뀐 경우)"
        rows.extend(row for row in listed if isinstance(row, dict))
    if not rows:
        return [], "순위 행이 없습니다 (휴장일이거나 아직 집계 전)"
    if any(row.get("estimated") is True for row in rows):
        return [], "장중 추정 순위라 순매수 금액이 없어 쓰지 않습니다 (확정 값이 나오면 다시)"

    collected_at = kst.stamp()
    records: list[dict] = []
    for row in rows:
        code = str(row.get("itemcode") or "").strip()
        name = str(row.get("itemname") or "").strip()
        amount = to_float(row.get("accTradeAmount"))
        if not code or not name or amount is None or amount == 0:
            continue
        net_eok = round(amount / 100_000_000.0, 1)
        net_eok = abs(net_eok) if trade_type == "순매수" else -abs(net_eok)
        day = _iso_date(row.get("bizdateTo"))
        records.append({
            "code": code,
            "name": name,
            "price": to_float(row.get("nowPrice")),
            "changePct": to_float(row.get("prevChangeRate")),
            "netAmountEok": net_eok,
            "netVolume": to_int(row.get("accTradeVolume")),
            "source": f"Naver 투자자별 매매상위 ({investor}, {day or '기준일 모름'})",
            "collectedAt": collected_at,
            "dataDate": day,
        })
    if not records:
        return [], "순위 행에 순매수 금액이 없습니다 (확정 전이거나 API 형식이 바뀐 경우)"
    return _rank(records, trade_type, top_n), None


# 토스 투자자 매매 레코드에서 각 투자주체가 있는 자리. 기관 세부 셋은 breakdown 안에 있습니다.
TOSS_INVESTOR_PATHS = {
    "외국인": ("investors", "foreigner"),
    "기관": ("investors", "institution"),
    "개인": ("investors", "individual"),
    "연기금": ("breakdown", "pensionFund"),
    "금융투자": ("breakdown", "financialInvestment"),
    "투신": ("breakdown", "trust"),
}
TOSS_UNIVERSE_MAX_AGE_HOURS = 26


def _toss_net(record: dict, investor: str) -> int | None:
    group, key = TOSS_INVESTOR_PATHS[investor]
    node = (record.get(group) or {}).get(key) if isinstance(record.get(group), dict) else None
    return node.get("net") if isinstance(node, dict) else None


# KRX 저장본을 '가장 가까운 앞 거래일'로 찾을 때 거슬러 보는 날 수(달력일) — 연휴를 넘을 만큼.
KRX_NEAREST_DAYS = 7


def fetch_krx_stored_ranking(
    date_str: str, market: str, investor: str, trade_type: str, top_n: int, *, nearest: bool,
) -> list[dict]:
    """
    KRX 정보데이터시스템 확정 순위(수집기 info_krx_daily가 저장한 관측치 ``krx_investor_rank``)를 읽습니다 — 외부 호출 없음.

    :param nearest: 그 날짜가 없으면 ``KRX_NEAREST_DAYS`` 안의 가장 가까운 앞 날짜를 씁니다(당일 조회 — 확정은 저녁이라 장중에는 앞 거래일).
        False면 그 날짜만(과거 조회 — 날짜를 바꿔 다른 날 값을 그 날 값처럼 보이지 않게).
    """
    day = _iso_date(date_str)
    if day is None:
        return []
    combo = {"market": market, "investor": investor, "tradeType": trade_type}
    try:
        if nearest:
            earliest = (date.fromisoformat(day) - timedelta(days=KRX_NEAREST_DAYS)).isoformat()
            dates = [d for d in store.list_observation_dates(catalog.OBS_KRX_INVESTOR_RANK, filters=combo) if earliest <= d <= day]
            if not dates:
                return []
            day = max(dates)
        rows = store.read_observations(catalog.OBS_KRX_INVESTOR_RANK, obs_date=day, filters=combo)
    except Exception as exc:  # noqa: BLE001 — 저장소를 읽지 못하면 이 단계만 건너뜁니다
        logger.warning("KRX 저장본 읽기 실패: %s", exc)
        return []
    if not rows:
        return []
    rows.sort(key=lambda r: r.get("rank") or 10_000)
    out = []
    for row in rows[:top_n]:
        record = {k: row.get(k) for k in ("rank", "code", "name", "price", "changePct", "netAmountEok", "netVolume", "dataDate")}
        record["source"] = f"KRX 정보데이터시스템 확정 ({investor}, {day})"
        record["collectedAt"] = row.get("collectedAt")
        out.append(record)
    return out


def fetch_toss_ranking(market: str, investor: str, trade_type: str, top_n: int) -> list[dict]:
    """
    토스증권 공식 데이터로 만든 수급 순위 — **거래대금 상위 N종목 안에서만**.

    저장본(``toss_radar_universe`` 태스크가 1시간마다 받음)만 읽고 외부를 부르지 않습니다.

    규칙
      - 투자주체마다 값이 있는 가장 최근 날짜를 고르고, 종목들이 가장 많이 가진 날짜 하나로
        맞춥니다(당일 잠정치에는 개인·기관 세부가 없어 전 거래일 확정치가 됩니다).
        날짜가 다른 종목을 한 표에 섞지 않습니다.
      - 금액(억)은 **순매수 주식 수 × 현재가**로 추정한 값입니다. 토스 종목 매매동향은
        거래량(주)만 주고 거래대금은 주지 않습니다.
      - 출처 문구에 "거래대금 상위 N종목 한정"과 기준일·추정 여부를 반드시 적습니다.
    """
    _TOSS_LAST_REASON["value"] = None
    if investor not in TOSS_INVESTOR_PATHS:
        _TOSS_LAST_REASON["value"] = f"'{investor}'{_object_particle(investor)} 지원하지 않습니다"
        return []
    snap = store.read_snapshot(catalog.SNAP_TOSS_RADAR_UNIVERSE)
    if not snap or not snap.payload:
        _TOSS_LAST_REASON["value"] = (
            "저장본이 없습니다 (toss_radar_universe 태스크 — 키 미설정이거나 아직 수집 전)"
            if toss.has_credentials() else "키가 없어 건너뜁니다 (.env의 TOSS_CLIENT_ID/SECRET)"
        )
        return []
    if snap.age_seconds > TOSS_UNIVERSE_MAX_AGE_HOURS * 3600:
        _TOSS_LAST_REASON["value"] = f"저장본이 {int(snap.age_seconds // 3600)}시간 지나 쓰지 않습니다"
        return []

    picks: list[tuple[dict, dict, int]] = []
    for stock in snap.payload.get("stocks") or []:
        if stock.get("market") != market:
            continue
        for record in stock.get("records") or []:
            net = _toss_net(record, investor)
            if net is not None:
                picks.append((stock, record, net))
                break
    if not picks:
        _TOSS_LAST_REASON["value"] = f"{market} 종목에 '{investor}' 값이 없습니다"
        return []

    dates = [record.get("date") for _, record, _ in picks]
    target = max(set(dates), key=lambda d: (dates.count(d), d or ""))
    universe = int(snap.payload.get("universe") or 0)
    source = (
        f"토스증권 공식 — 거래대금 상위 {universe}종목 중 순위 (시장 전체 순위 아님) · "
        f"{target} 기준 · 금액 = 순매수 주식 수 × 현재가 (추정)"
    )
    records: list[dict] = []
    for stock, record, net in picks:
        if record.get("date") != target or not net:
            continue
        if (trade_type == "순매수") != (net > 0):
            continue
        price = stock.get("lastPrice")
        records.append({
            "code": str(stock.get("code")),
            "name": stock.get("name") or str(stock.get("code")),
            "price": price,
            "changePct": stock.get("changePct"),
            "netAmountEok": round(net * price / 1e8, 1) if price else None,
            "netVolume": net,
            "source": source,
            "collectedAt": kst.stamp(snap.collected_at) if snap.collected_at else None,
            # 기준일은 토스 기록의 날짜(전 거래일일 수 있음), 금액은 추정치 — 이력에 쌓지 않습니다(QA-029).
            "dataDate": _iso_date(target),
            "isEstimated": True,
        })
    if not records:
        _TOSS_LAST_REASON["value"] = f"{target} 기준 {trade_type} 종목이 없습니다"
    return _rank(records, trade_type, top_n)


def test_toss_connection() -> dict:
    """진단 — 레이더가 쓰는 토스 경로를 실제로 부르고, 폴백 저장본의 상태도 함께 적습니다."""
    result = toss.test_connection_flows()
    snap = store.read_snapshot(catalog.SNAP_TOSS_RADAR_UNIVERSE)
    if snap and snap.payload:
        stocks = snap.payload.get("stocks") or []
        result["message"] += (
            f" · 폴백 저장본: 거래대금 상위 {len(stocks)}종목, "
            f"수집 {kst.stamp(snap.collected_at) if snap.collected_at else '시각 모름'}"
        )
    elif result.get("ok"):
        result["message"] += " · 폴백 저장본 없음 (toss_radar_universe 첫 실행 전)"
    return result


# ==============================================================================
# 4. 누적 이력 (외부 소스가 모두 실패했을 때)
# ==============================================================================
def accumulate_history(
    rows: list[dict],
    market: str,
    investor: str,
    trade_type: str,
    interval_type: str,
) -> int:
    """
    수집된 랭킹을 "데이터 기준 거래일"로 누적합니다.

    기준일은 수집 시각이 아니라 latest_completed_session()이 계산한 거래일을
    씁니다. Naver/Daum이 "가장 최근에 끝난 거래일"만 주기 때문에, 수집 시각으로
    찍으면 토요일 새벽에 받은 금요일 데이터가 토요일로 기록됩니다.

    같은 날·같은 조합은 **교체**합니다. 장중에는 5분마다 수집하므로 상위 N의
    구성이 계속 바뀌는데, upsert만 하면 밀려난 종목이 옛 시각의 값으로 남아
    하루치가 N행이 아니라 합집합(실제로 30행이 55~57행)이 됐습니다. 그러면
    백업 읽기가 시각이 다른 값을 섞어 "그날의 상위 N"이라고 돌려줍니다.
    """
    if not rows:
        return 0
    if any(row.get("isEstimated") for row in rows):
        # 추정치(토스 '거래대금 상위 N종목 안' 순위 · 주식 수 × 현재가)는 시장 전체 순위가 아니고 금액도 추정입니다.
        # 쌓으면 그날의 실제 상위 30을 교체합니다(QA-029). 화면에는 그대로 보이고, 이력에만 남기지 않습니다.
        logger.info("수급 레이더 이력 누적 건너뜀: 추정치 (%s/%s/%s/%s)", market, investor, trade_type, interval_type)
        return 0

    obs_date = _iso_date(rows[0].get("dataDate"))
    if obs_date is None:
        session_str = latest_completed_session()
        obs_date = f"{session_str[:4]}-{session_str[4:6]}-{session_str[6:8]}"
    prefix = f"{market}|{investor}|{trade_type}|{interval_type}|"

    records = []
    for row in rows:
        record = dict(row)
        record.update({
            "market": market,
            "investor": investor,
            "tradeType": trade_type,
            "intervalType": interval_type,
        })
        # 같은 거래일에 조건별로 여러 건이 들어오므로 entity에 조건을 포함해야
        # 서로 덮어쓰지 않습니다.
        record["entity"] = f"{prefix}{record.get('code', '?')}"
        records.append(record)

    saved = store.replace_observations(
        catalog.OBS_RADAR, obs_date, prefix, records, entity_key="entity"
    )
    logger.info(
        "수급 레이더 이력 누적: date=%s, rows=%s (%s/%s/%s/%s)",
        obs_date, saved, market, investor, trade_type, interval_type,
    )
    return saved


def read_from_history(
    target_day: date,
    market: str,
    investor: str,
    trade_type: str,
    top_n: int,
    interval_type: str = "TODAY",
) -> dict | None:
    """
    누적 이력에서 해당 조건의 랭킹을 꺼냅니다.

    요청한 날짜에 이력이 없으면 **그 조합의 이력이 있는, 그보다 앞선 가장 가까운
    거래일**을 씁니다. 어느 날짜를 썼는지 source에 남겨 화면이 밝힐 수 있게 합니다.

    기간 구간(interval_type)도 조건입니다. 당일 백업에 5·20거래일 누적 금액이
    섞이면 10~20배 큰 값이 "오늘 순매수" 1위로 올라갑니다.
    """
    try:
        target_str = target_day.isoformat()
        combo = {
            "market": market,
            "investor": investor,
            "tradeType": trade_type,
            "intervalType": interval_type,
        }
        available = [
            day for day in store.list_observation_dates(catalog.OBS_RADAR, filters=combo)
            if day <= target_str
        ]
        if not available:
            return None

        picked = max(available)
        rows = store.read_observations(catalog.OBS_RADAR, obs_date=picked, filters=combo)
        if not rows:
            return None

        rows.sort(
            key=lambda r: r.get("netAmountEok") or 0.0,
            reverse=(trade_type == "순매수"),
        )
        rows = rows[:top_n]
        source = f"누적 이력 (수집기가 {picked}에 저장한 값 · 외부 소스 전부 실패)"
        for index, row in enumerate(rows, start=1):
            row["rank"] = index
            row["source"] = source
            row.pop("entity", None)

        return {
            "source": source,
            "sourceKind": "history",
            "isHistorical": True,
            "historyDate": picked,
            "rows": rows,
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("누적 이력 조회 실패: %s", exc)
        return None


# ==============================================================================
# 5. 연결 진단
# ==============================================================================
def test_daum_connection() -> dict:
    """화면이 실제로 쓰는 경로(investor_purchase API)를 그대로 호출합니다."""
    rows = fetch_daum_ranking(
        latest_completed_session(), "KOSPI", "외국인", "순매수", 5, "TODAY"
    )
    if rows:
        return {"ok": True, "stage": "ok", "message": f"{len(rows)}건 수신", "sample": rows[:3]}
    return {
        "ok": False, "stage": "empty",
        "message": "빈 결과입니다. 휴장일이거나 Daum 응답 구조가 바뀌었을 수 있습니다.",
    }


def test_naver_connection() -> dict:
    rows = fetch_naver_ranking(
        latest_completed_session(), "KOSPI", "외국인", "순매수", 5
    )
    if rows:
        return {"ok": True, "stage": "ok", "message": f"{len(rows)}건 수신", "sample": rows[:3]}
    reason = _NAVER_LAST_REASON["value"]
    return {
        "ok": False, "stage": "empty",
        "message": (
            f"빈 결과입니다. {reason}" if reason
            else "빈 결과입니다. 페이지 구조 변경 또는 차단을 의심하세요."
        ),
    }


# ==============================================================================
# 내부 헬퍼
# ==============================================================================
def _rank(records: list[dict], trade_type: str, top_n: int) -> list[dict]:
    if not records:
        return []
    records.sort(
        key=lambda r: r.get("netAmountEok") or 0.0,
        reverse=(trade_type == "순매수"),
    )
    top = records[:top_n]
    for index, record in enumerate(top, start=1):
        record["rank"] = index
    return top


def _iso_date(value) -> str | None:
    """'YYYY-MM-DD' 또는 'YYYYMMDD'를 'YYYY-MM-DD'로. 날짜가 아니면 None."""
    text = str(value or "").strip()[:10].replace("-", "")
    if len(text) != 8 or not text.isdigit():
        return None
    try:
        return date(int(text[:4]), int(text[4:6]), int(text[6:8])).isoformat()
    except ValueError:
        return None
