"""
app/services/krx_data.py
KRX 정보데이터시스템(data.krx.co.kr) — 계정 로그인으로 받는 공식 통계 (ADR 0036).

[로그인] 화면이 하는 순서 그대로 세 번: 로그인 화면(세션 쿠키) → 로그인 틀(login.jsp) → 로그인 요청(``MDCCOMS001D1.cmd`` — 성공 ``CD001``).
  같은 계정이 다른 곳(브라우저)에 로그인해 있어 ``CD011``(중복 로그인)이 오면 ``skipDup=Y``로 한 번 더 보냅니다 — 그 다른 세션이 끊길 수
  있습니다. ``CD010``(비밀번호 변경 필요)이나 그 밖의 코드면 받지 않고 멈춥니다(계정 값은 로그·기록에 싣지 않음). 계정은 ``KRX_ID``·``KRX_PW``.
[자료] ``comm/bldAttendant/getJsonData.cmd``에 화면 번호(bld)를 붙여 POST — 한 번에 그 시장 전 종목이 옵니다(코스피 약 900행).
  - 투자자별 순매수 상위 ``MDCSTAT02401`` — 외국인·기관합계·개인·연기금·금융투자·투신 × 코스피·코스닥(12건). 순매수·순매도 상위 50씩 남깁니다.
  - 투자자별 거래실적(시장 합계) ``MDCSTAT02201`` — 코스피·코스닥(2건).
  - 외국인 보유량 ``MDCSTAT03701`` — 코스피·코스닥(2건). 보유 비중 상위 30.
  - 공매도 거래 ``MDCSTAT30101`` — 코스피·코스닥(2건). 공매도 거래대금 상위 30. 공매도 잔고 ``MDCSTAT30501`` — 2~3거래일 늦게 공개되어
    기준일 2거래일 앞부터 최대 세 날짜를 거슬러 처음 나오는 날(시장마다 1~3건). 잔액 상위 30.
네트워크는 차단 통과 계층(app/fetch — 계층 1만, POST라 브라우저 계층은 쓰지 않음)으로만 나갑니다. 숫자는 쉼표를 뗀 값이고, 빈 칸은 None입니다.
"""
from __future__ import annotations

import json
from typing import Callable

from .. import settings
from ..fetch import ladder
from ..numbers import to_float, to_int
from .info_text import ShapeError

HOST = "data.krx.co.kr"
LOGIN_PAGE = "https://data.krx.co.kr/contents/MDC/COMS/client/MDCCOMS001.cmd"
LOGIN_FRAME = "https://data.krx.co.kr/contents/MDC/COMS/client/view/login.jsp?site=mdc"
LOGIN_URL = "https://data.krx.co.kr/contents/MDC/COMS/client/MDCCOMS001D1.cmd"
DATA_URL = "https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd"
DATA_REFERER = "https://data.krx.co.kr/contents/MDC/MDI/outerLoader/index.cmd"
SOURCE = "KRX 정보데이터시스템"
SOURCE_URL = "https://data.krx.co.kr/"

MARKETS = {"KOSPI": "STK", "KOSDAQ": "KSQ"}
SHORT_BALANCE_MARKETS = {"KOSPI": "1", "KOSDAQ": "2"}
# 레이더의 투자주체 이름 → KRX 투자자 코드. 외국인은 '외국인'(9000)만 — 기타외국인(9001)은 빼는 KRX 화면 기본과 같음.
INVESTORS = {"외국인": "9000", "기관": "7050", "개인": "8000", "연기금": "6000", "금융투자": "1000", "투신": "3000"}
RANK_KEEP = 50
TOP_KEEP = 30

Fetch = Callable[..., ladder.Fetched]


class KrxLoginError(Exception):
    """
    로그인하지 못함 — 계정 없음·비밀번호 변경 필요·거절. 메시지에 계정 값을 싣지 않습니다.

    ``code``는 KRX가 로그인 요청에 답한 거절 코드입니다(``CD010`` 등, 코드 칸이 비었으면 '코드 없음'). 계정 값이 설정되지 않아 요청을
    보내지 않은 경우는 None — 부르는 쪽(tasks/info.collect_krx)이 KRX의 거절일 때만 그 호스트를 닫습니다(QA-390).
    """

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


def credentials() -> tuple[str, str]:
    return settings.krx_login()


def _json(fetched: ladder.Fetched):
    try:
        return json.loads(fetched.body)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ShapeError(f"KRX 응답이 JSON이 아님(HTTP {fetched.status} — 로그인이 풀렸거나 화면 형식이 바뀐 경우)") from exc


def login(fetch: Fetch = ladder.fetch) -> None:
    """
    로그인해 세션 쿠키를 받습니다(계층 1 세션에 남아 이어지는 요청이 씀).

    :raises KrxLoginError: 계정 없음·비밀번호 변경 필요·거절
    :raises ladder.FetchRejected·FetchSkipped·FetchFailed: 출처가 거부·예산 부족·받지 못함
    """
    user, password = credentials()
    if not user or not password:
        raise KrxLoginError("KRX_ID·KRX_PW가 설정되지 않음")
    fetch(LOGIN_PAGE)
    fetch(LOGIN_FRAME, headers={"Referer": LOGIN_PAGE})
    form = {"mbrNm": "", "telNo": "", "di": "", "certType": "", "mbrId": user, "pw": password}
    code = _login_code(fetch(LOGIN_URL, method="POST", data=form, headers={"Referer": LOGIN_PAGE}))
    if code == "CD011":
        form["skipDup"] = "Y"
        code = _login_code(fetch(LOGIN_URL, method="POST", data=form, headers={"Referer": LOGIN_PAGE}))
    if code == "CD010":
        raise KrxLoginError("KRX가 비밀번호 변경을 요구함(CD010) — krx.co.kr에서 바꾼 뒤 .env를 고침", code=code)
    if code != "CD001":
        raise KrxLoginError(f"KRX 로그인 거절({code or '코드 없음'})", code=code or "코드 없음")


def _login_code(fetched: ladder.Fetched) -> str:
    body = _json(fetched)
    return str(body.get("_error_code") or "") if isinstance(body, dict) else ""


def data(bld: str, params: dict, fetch: Fetch = ladder.fetch) -> list[dict]:
    """
    화면 번호 ``bld``의 자료 행. 응답의 ``output``·``OutBlock_1`` 가운데 있는 것.

    :raises ShapeError: JSON이 아니거나 행 목록 칸이 없음
    """
    body = _json(fetch(DATA_URL, method="POST", data={"bld": bld, "locale": "ko_KR", "csvxls_isNo": "false", **params},
                       headers={"Referer": DATA_REFERER, "X-Requested-With": "XMLHttpRequest"}))
    if not isinstance(body, dict):
        raise ShapeError("KRX 응답 모양이 다름(객체가 아님)")
    rows = body.get("output", body.get("OutBlock_1"))
    if not isinstance(rows, list):
        raise ShapeError(f"KRX 응답 모양이 다름(output·OutBlock_1 없음 — {bld.rsplit('/', 1)[-1]})")
    return [row for row in rows if isinstance(row, dict)]


def _eok(won) -> float | None:
    value = to_float(won)
    return None if value is None else round(value / 100_000_000.0, 1)


# ------------------------------------------------------------------ 파서 (네트워크를 모름)
def parse_rankings(rows: list[dict], *, market: str, investor: str, day: str) -> list[dict]:
    """
    투자자별 순매수 상위(전 종목) → 순매수 상위 50 + 순매도 상위 50 레코드(레이더 이력과 같은 칸 + entity).

    순매수 금액(원)이 없거나 0인 종목은 순위에서 뺍니다(모르는 값으로 순위를 매기지 않음).
    """
    stocks = []
    for row in rows:
        code = str(row.get("ISU_SRT_CD") or "").strip()
        name = str(row.get("ISU_NM") or row.get("ISU_ABBRV") or "").strip()
        net = _eok(row.get("NETBID_TRDVAL"))
        if not code or not name or net is None or net == 0:
            continue
        stocks.append({"code": code, "name": name, "netAmountEok": net, "netVolume": to_int(row.get("NETBID_TRDVOL")),
                       "buyEok": _eok(row.get("BID_TRDVAL")), "sellEok": _eok(row.get("ASK_TRDVAL"))})
    out: list[dict] = []
    for trade_type, picked in (("순매수", sorted((s for s in stocks if s["netAmountEok"] > 0), key=lambda s: -s["netAmountEok"])),
                               ("순매도", sorted((s for s in stocks if s["netAmountEok"] < 0), key=lambda s: s["netAmountEok"]))):
        for rank, stock in enumerate(picked[:RANK_KEEP], start=1):
            out.append({
                **stock, "rank": rank, "market": market, "investor": investor, "tradeType": trade_type,
                "price": None, "changePct": None, "dataDate": day,
                "source": f"{SOURCE} ({investor}, {day})",
                "entity": f"{market}|{investor}|{trade_type}|{stock['code']}",
            })
    return out


def parse_totals(rows: list[dict]) -> list[dict]:
    """투자자별 거래실적(시장 합계) → [{investor, buyEok, sellEok, netEok, netVolume}] (KRX가 준 순서)."""
    out = []
    for row in rows:
        name = str(row.get("INVST_TP_NM") or "").strip()
        if not name:
            continue
        out.append({"investor": name, "buyEok": _eok(row.get("BID_TRDVAL")), "sellEok": _eok(row.get("ASK_TRDVAL")),
                    "netEok": _eok(row.get("NETBID_TRDVAL")), "netVolume": to_int(row.get("NETBID_TRDVOL"))})
    return out


def parse_foreign(rows: list[dict]) -> list[dict]:
    """외국인 보유량(전 종목) → 보유 비중 상위 30 [{code, name, close, changePct, holdShares, holdPct, limitExhaustPct}]."""
    stocks = []
    for row in rows:
        code = str(row.get("ISU_SRT_CD") or "").strip()
        pct = to_float(row.get("FORN_SHR_RT"))
        if not code or pct is None:
            continue
        stocks.append({"code": code, "name": str(row.get("ISU_ABBRV") or "").strip() or None,
                       "close": to_float(row.get("TDD_CLSPRC")), "changePct": to_float(row.get("FLUC_RT")),
                       "holdShares": to_int(row.get("FORN_HD_QTY")), "holdPct": pct,
                       "limitExhaustPct": to_float(row.get("FORN_LMT_EXHST_RT"))})
    return sorted(stocks, key=lambda s: -s["holdPct"])[:TOP_KEEP]


def parse_short_trades(rows: list[dict]) -> list[dict]:
    """공매도 거래(전 종목) → 공매도 거래대금 상위 30 [{code, name, shortEok, shortVolume, tradeValueWeightPct, tradeVolumeWeightPct}]."""
    stocks = []
    for row in rows:
        code = str(row.get("ISU_CD") or row.get("ISU_SRT_CD") or "").strip()
        value = _eok(row.get("CVSRTSELL_TRDVAL"))
        if not code or value is None or value == 0:
            continue
        stocks.append({"code": code, "name": str(row.get("ISU_ABBRV") or "").strip() or None, "shortEok": value,
                       "shortVolume": to_int(row.get("CVSRTSELL_TRDVOL")),
                       "tradeValueWeightPct": to_float(row.get("TRDVAL_WT")), "tradeVolumeWeightPct": to_float(row.get("TRDVOL_WT"))})
    return sorted(stocks, key=lambda s: -s["shortEok"])[:TOP_KEEP]


def parse_short_balances(rows: list[dict]) -> list[dict]:
    """공매도 잔고(전 종목) → 잔고 금액 상위 30 [{code, name, balanceEok, balanceShares, balancePct}]."""
    stocks = []
    for row in rows:
        code = str(row.get("ISU_CD") or row.get("ISU_SRT_CD") or "").strip()
        value = _eok(row.get("BAL_AMT"))
        if not code or value is None or value == 0:
            continue
        stocks.append({"code": code, "name": str(row.get("ISU_ABBRV") or "").strip() or None, "balanceEok": value,
                       "balanceShares": to_int(row.get("BAL_QTY")), "balancePct": to_float(row.get("BAL_RTO"))})
    return sorted(stocks, key=lambda s: -s["balanceEok"])[:TOP_KEEP]


# ------------------------------------------------------------------ 요청 목록
def ranking_params(market: str, investor: str, day: str) -> dict:
    return {"mktId": MARKETS[market], "invstTpCd": INVESTORS[investor], "strtDd": day, "endDd": day}


def totals_params(market: str, day: str) -> dict:
    return {"inqTpCd": "1", "trdVolVal": "2", "askBid": "3", "mktId": MARKETS[market], "etf": "EF", "etn": "EN",
            "elw": "EW", "strtDd": day, "endDd": day}


def foreign_params(market: str, day: str) -> dict:
    return {"searchType": "1", "mktId": MARKETS[market], "trdDd": day, "isuLmtRto": "0"}


def short_trade_params(market: str, day: str) -> dict:
    return {"trdDd": day, "mktId": MARKETS[market], "inqCond": "STMFRTSCIFDRFS"}


def short_balance_params(market: str, day: str) -> dict:
    return {"trdDd": day, "mktTpCd": SHORT_BALANCE_MARKETS[market]}
