/**
 * 🧪 모의매매(한국) 화면의 고정 표 — 네 계좌의 정의(계좌 상세 패널)와 아직 열지 않은 한국 탭. React를 모르는 순수 모듈(ADR 0004).
 *
 * 문장은 백엔드 한국 규칙(KrRuleBookService·KrStartPipeline·KrPaperMarket·KrFills·KrConfirmations — 2단계 명세 §4-1·§4-6~§4-9)을 옮긴
 * 것이고, **설정에서 오는 숫자는 문장에 적지 않습니다**(미국 ACCOUNT_PROFILES와 같은 규칙) — 숫자는 `settings`의 `kr.*` 키로 설정 응답에서
 * 읽어 따로 적습니다(lib/paper accountSettingRows). 문장에 남은 숫자는 코드에 고정된 값입니다(20거래일 창 — KrRules, 코스피 시총 상위 100 —
 * 유니버스 규칙 판, 벤치마크 구성 069500 100%·069500 60%·153130 40% — PaperBooks.KR).
 *
 * 이 파일은 lib/paper의 타입만 가져옵니다(lib/paper가 이 표를 가져오므로 값 import를 두지 않음 — 순환 방지).
 */
import type { AccountProfile, PaperTabKey } from "./paper";

/** 결정·체결 시점의 공통 문장 — 한국 계좌는 네 계좌 모두 다음 KR 거래일 시가(KRX 시가 단일가)에 체결합니다. */
const KR_FILL =
  "주문은 다음 KR 거래일 시가(KRX 시가 단일가 — 잠정가는 토스증권 1분봉 개장 봉, 확정가는 금융위원회)에 체결하고, 금융위 값이 들어오면 "
  + "체결 행은 그대로 둔 채 '확정 조정' 행으로 현금·평단을 맞춥니다.";

/** 네 계좌가 함께 출발하는 문장(K28 — 미국의 출발일 종가 사후 체결은 없음). */
const KR_START =
  "한국 네 계좌는 출발일 S 밤의 결정으로 S+1 시가에 함께 출발합니다(사후 체결 없음). 출발 결정이 미뤄지면(Claude 출발 호출 실패 등) "
  + "네 계좌 모두 다음 KR 거래일로 함께 미뤄집니다.";

/** 한국 네 계좌의 정의(계좌 코드 → 소개). 미국 표(lib/paper ACCOUNT_PROFILES)와 같은 모양입니다. */
export const KR_ACCOUNT_PROFILES: Readonly<Record<string, AccountProfile>> = {
  kr_rules: {
    summary: "외국인·기관이 함께 사는 코스피 대형주를 규칙대로 따르는 대조군 — 재량 없음",
    definitions: [
      {
        key: "method",
        label: "운용 방식",
        text: "코스피 시총 상위 100 보통주(유니버스 U — 금융위 기준일) 가운데 외국인·기관의 20거래일 누적 순매수(주)가 둘 다 0보다 큰 "
          + "종목을 후보로, 점수(두 순매수 합 ÷ 상장주식수) 순으로 고릅니다. KR 거래일마다 결정 시각(밤)에 한 번 결정하고, 자료 게이트를 "
          + "모두 통과해야 결정합니다(기한이 지나면 그 세션은 주문 없음).",
      },
      {
        key: "buy",
        label: "매수",
        text: "재선정일(설정 주기 — 기본 그 달 첫 KR 거래일)과 출발 때만 삽니다 — 재무(ROE > 0, 금융업 코드 표 밖 회사는 부채비율 상한)·"
          + "거래정지·재진입 금지를 거른 후보 상위 종목을 설정 배분(동일 비중 또는 점수 비례)으로 삽니다. 재선정일 결정이 게이트·기한으로 "
          + "빠지면 다음 KR 결정일에 그날 자료로 다시 선정합니다(따라잡기). " + KR_FILL,
      },
      {
        key: "sell",
        label: "매도·리스크",
        text: "매일 20일 누적이 둘 다 0보다 작으면 팔고, 재선정일에는 후보 밖 보유를 팝니다. 트레일링 스탑(최고가 대비 설정 비율 — 밤 잠정 "
          + "평가가로 감지해 다음 거래일 시가에 체결, 그때 확정 종가로 다시 판정)과 재진입 금지는 장부가 적용합니다 — 현금성 제외.",
      },
      {
        key: "cash",
        label: "현금",
        text: "후보가 모자란 만큼과 남는 현금은 153130(KODEX 단기채권, 현금성)에 둡니다 — 그래서 결과는 종목 신호와 주식 노출이 섞인 "
          + "값이고, 개요의 순자산 곡선에 노출 맞춘 참고선을 함께 그립니다.",
      },
      { key: "start", label: "시작·출발일", text: `${KR_START} 출발 배분은 출발일의 재선정과 같은 계산입니다.` },
      {
        key: "purpose",
        label: "비교 목적",
        text: "대조군 — 같은 수급 자료를 재량 없이 따랐을 때의 성과입니다. KODEX 200 계좌와 비교합니다. 한국 규칙 계좌 설정(kr.*)을 "
          + "바꾸면 실험 조건이 바뀝니다.",
      },
    ],
    settings: [
      { key: "kr.rulesMaxNames", label: "매수 종목 수 상한", unit: "종목" },
      {
        key: "kr.rules.weighting",
        label: "배분 방식",
        labels: { EQUAL: "동일 비중(EQUAL)", SCORE: "점수 비례(SCORE)" },
      },
      { key: "kr.maxWeightStockPct", label: "종목 비중 상한", unit: "%" },
      { key: "kr.rules.minStreakDays", label: "연속 순매수 최소", unit: "일" },
      { key: "kr.rules.debtRatioMaxPct", label: "비금융 부채비율 상한", unit: "%" },
      {
        key: "kr.rules.reselection",
        label: "재선정 주기",
        labels: { MONTHLY_FIRST: "그 달 첫 KR 거래일(MONTHLY_FIRST)", TWICE_MONTHLY: "월 2회(TWICE_MONTHLY)" },
      },
      { key: "kr.trailingStopPct", label: "트레일링 스탑", unit: "%" },
      { key: "kr.lockoutTradingDays", label: "스탑 뒤 재진입 금지", unit: " KR 거래일" },
      { key: "kr.rules.parkCashThresholdPct", label: "153130 매수 기준(순자산 대비)", unit: "%" },
      { key: "kr.minOrderNotional", label: "최소 주문 금액", unit: "원" },
      { key: "kr.cashLikeTickers", label: "현금성 종목" },
    ],
  },
  kr_claude: {
    summary: "Claude가 한국 패킷을 읽고 주문을 제안하고, 검증기가 하드 규칙으로 거르는 실험군",
    definitions: [
      {
        key: "method",
        label: "운용 방식",
        text: "KR 거래일마다 결정 시각(밤)에 한 번, 자료 게이트를 모두 통과하면 한국 패킷 — 매크로·국면(전날 밤 판정)·수급·재무(DART)·"
          + "시세·사건 뉴스·보유·최근 결정·메모·하드 규칙 — 을 Claude에 보내 주문 목록과 목표 주식 노출을 받습니다. 판단 원칙은 두 시장이 "
          + "함께 쓰는 프레임 판에 한국 하드 규칙 줄·고정 문단이 덮인 시스템 프롬프트입니다.",
      },
      {
        key: "buy",
        label: "매수",
        text: "Claude가 제안한 매수 가운데 검증기(하드 규칙)를 통과한 것만 대기 주문이 됩니다 — 종목·ETF 비중 상한, 최대 종목 수(현금성 "
          + "제외), 최소 주문 금액, 월 재량 주문 상한, 재진입 금지, 유니버스, 체결할 수 없는 종목(거래정지·봉 없음·기업행위 보류 — "
          + "UNFILLABLE), 1주에 못 미침(BUY_BELOW_ONE_SHARE), 정수 주. " + KR_FILL,
      },
      {
        key: "sell",
        label: "매도·리스크",
        text: "재량 매도는 최소 보유 거래일(KRX)이 지난 종목만 통과합니다(현금성 예외). 트레일링 스탑·재진입 금지는 장부가 따로 적용합니다 — "
          + "다음 거래일 시가에 체결하고 확정 종가로 다시 판정합니다. 호출 실패·형식 오류인 날은 재량 주문이 없고, 기한이 지나면 그 세션은 "
          + "부르지 않습니다.",
      },
      {
        key: "cash",
        label: "현금",
        text: "현금 비중·주식 노출은 Claude가 정합니다. 남는 현금은 153130(현금성)에 둘 수 있습니다. 목표 노출은 기록·표시용이고 집행은 "
          + "주문 기준입니다.",
      },
      { key: "start", label: "시작·출발일", text: `${KR_START} 미국처럼 계좌별 시작·미리보기는 없습니다.` },
      {
        key: "purpose",
        label: "비교 목적",
        text: "실험군 — 매크로·수급·재무·사건을 함께 읽는 재량 판단이 기계적 규칙(한국 규칙 계좌)과 시장(KODEX 200 계좌)을 이기는지 "
          + "봅니다.",
      },
    ],
    settings: [
      { key: "model", label: "모델(두 책 공용)" },
      { key: "kr.decisionTimeKst", label: "결정 시각(KST)" },
      { key: "kr.decisionDeadlineKst", label: "결정 기한(KST)" },
      { key: "apiDailyCallCap", label: "하루 호출 상한(두 책 공유)", unit: "회" },
      { key: "kr.maxWeightStockPct", label: "종목 비중 상한", unit: "%" },
      { key: "kr.maxWeightEtfPct", label: "ETF 비중 상한", unit: "%" },
      { key: "kr.maxPositions", label: "최대 종목 수(현금성 제외)", unit: "종목" },
      { key: "kr.minOrderNotional", label: "최소 주문 금액", unit: "원" },
      { key: "kr.maxDiscretionaryOrdersPerMonth", label: "월 재량 주문 상한", unit: "건" },
      { key: "kr.minHoldTradingDaysForSell", label: "재량 매도 전 최소 보유", unit: " KR 거래일" },
      { key: "kr.trailingStopPct", label: "트레일링 스탑", unit: "%" },
      { key: "kr.lockoutTradingDays", label: "스탑 뒤 재진입 금지", unit: " KR 거래일" },
      { key: "kr.cashLikeTickers", label: "현금성 종목" },
    ],
  },
  kr_bench_k200: {
    summary: "출발 때 KODEX 200(069500) 100%를 사서 그대로 드는 시장 기준선",
    definitions: [
      { key: "method", label: "운용 방식", text: "결정을 내지 않습니다. 출발 때 069500을 한 번 사고 그대로 듭니다." },
      {
        key: "buy",
        label: "매수",
        text: "출발 결정 때 한 번 — 069500 100%를 S+1 시가에 정수 주로 삽니다(1주에 못 미치는 잔돈은 현금). 그 뒤로는 사지 않습니다.",
      },
      { key: "sell", label: "매도·리스크", text: "팔지 않습니다 — 트레일링 스탑을 걸지 않고 리밸런싱도 하지 않습니다." },
      { key: "cash", label: "현금", text: "1주를 채우지 못한 잔돈뿐입니다." },
      { key: "start", label: "시작·출발일", text: KR_START },
      {
        key: "purpose",
        label: "비교 목적",
        text: "시장 기준선 — 한국 다른 세 계좌 통계의 초과 수익률·베타는 이 계좌 대비입니다.",
      },
    ],
    settings: [
      { key: "kr.slippageBp", label: "슬리피지(네 계좌 공통 — 비용 칸)", unit: "bp" },
      { key: "kr.commissionBp", label: "수수료(가정)", unit: "bp" },
    ],
  },
  kr_bench_mix: {
    summary: "출발 때 069500 60%·153130 40%를 사서 그대로 드는 단순 배분 기준 — 리밸런싱 없음",
    definitions: [
      { key: "method", label: "운용 방식", text: "결정을 내지 않습니다. 출발 때 069500 60%·153130 40%를 한 번 사고 그대로 듭니다." },
      {
        key: "buy",
        label: "매수",
        text: "출발 결정 때 한 번 — 두 종목을 S+1 시가에 정수 주로 삽니다(잔돈은 현금). 그 뒤로는 사지 않습니다.",
      },
      {
        key: "sell",
        label: "매도·리스크",
        text: "팔지 않습니다 — 트레일링 스탑·리밸런싱이 없어 비중은 가격에 따라 60/40에서 벌어집니다.",
      },
      {
        key: "cash",
        label: "현금",
        text: "153130 40%가 현금성 몫입니다 — 현금성 종목(설정 kr.cashLikeTickers, 기본 153130)이라 구성 차트에서 현금과 한 묶음입니다. "
          + "그 밖의 현금은 잔돈뿐입니다.",
      },
      { key: "start", label: "시작·출발일", text: KR_START },
      {
        key: "purpose",
        label: "비교 목적",
        text: "주식을 덜 든 단순 배분과의 비교 — 통계는 KODEX 200 계좌 대비입니다.",
      },
    ],
    settings: [
      { key: "kr.slippageBp", label: "슬리피지(네 계좌 공통 — 비용 칸)", unit: "bp" },
      { key: "kr.commissionBp", label: "수수료(가정)", unit: "bp" },
      { key: "kr.cashLikeTickers", label: "현금성 종목" },
    ],
  },
};

/** 한국 화면에서 아직 열지 않은 탭 — 그 탭은 미국 화면을 한국 계좌로 그리지 않고 "다음 단계에서 엽니다"만 보입니다. */
export interface KrPendingTab {
  opensIn: string;
  upcoming: string;
}

/**
 * 한국 탭 중 아직 열지 않은 것(2단계 명세 §9 F2 — 다음 화면 커밋이 하나씩 엽니다). 개요·보유·체결·결정 로그는 열렸고, 프레임·설정은 두 시장이 함께 쓰는 화면이라
 * 시장을 밝힌 안내와 함께 그대로 보입니다(사용자 결정 2026-10-29).
 */
export const KR_PENDING_TABS: Readonly<Partial<Record<PaperTabKey, KrPendingTab>>> = {
  selection: {
    opensIn: "2단계 F2 화면 묶음",
    upcoming: "한국 규칙 재선정 — 유니버스·수급 신호·제외 표·DART/ROE '자료 없음' 사유·'금융업 코드 표 확인 필요' 경고",
  },
  notes: {
    opensIn: "2단계 F2 화면 묶음",
    upcoming: "한국 시황 메모 — KRX 달력으로 센 기준일·만료",
  },
};
