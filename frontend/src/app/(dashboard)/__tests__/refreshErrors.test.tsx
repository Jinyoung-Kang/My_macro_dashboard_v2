/**
 * 자동 갱신(또는 새로고침)이 실패하면 그 패널에 '⚠️ 새로 읽지 못함'을 보인다(QA-067).
 *
 * 실패하면 화면은 앞서 받은 값을 그대로 보이므로, 표시가 없으면 몇 시간 전 값이 지금 값처럼 남습니다. QA-050은 수집
 * 시각 배지가 있는 9개 화면에만 붙였고, 자동 갱신하는 나머지 패널(상태 화면, 매크로 위험·고급·스크래핑, 수급 패널,
 * 현물·선물 카드, KRX 선물 수급)은 조용했습니다.
 */
import { act, cleanup, configure, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { endpoints } from "@/lib/endpoints";
import AlertsPage from "../alerts/page";
import CorrelationPage from "../correlation/page";
import { SpotFuturesCard } from "../krx/SpotFuturesCard";
import KrxPage from "../krx/page";
import { FxCompareSection } from "../macro/FxCompareSection";
import MacroPage from "../macro/page";
import { ScrapedSection } from "../macro/ScrapedSection";
import { MarketFlowsPanel, StockFlowsPanel } from "../radar/FlowPanels";
import RadarPage from "../radar/page";
import RegimePage from "../regime/page";
import { RegimeLogSection } from "../regime/RegimeLogSection";
import { TrackRecordSection } from "../regime/TrackRecordSection";
import StatusPage from "../status/page";

const FAILED = "⚠️ 새로 읽지 못함";

/** 경로별 첫 응답이 훅에 건네진 기록. 훅의 await보다 먼저 then을 달아 두므로, 훅이 값을 받기 바로 앞에 찍힙니다. */
const delivered = new Set<string>();

/** 경로마다 첫 요청은 body로 답하고, 그 뒤(새로 읽기)는 실패. bodies에 없는 경로는 끝나지 않는 요청(경로는 정확히 일치). */
function firstThenFail(bodies: Record<string, unknown>) {
  const seen = new Set<string>();
  delivered.clear();
  api.apiGetShared.mockImplementation((path: string) => {
    if (!(path in bodies)) return new Promise(() => {});
    if (seen.has(path)) return Promise.reject(new Error("백엔드 API에 연결하지 못했습니다"));
    seen.add(path);
    const first = Promise.resolve(bodies[path]);
    void first.then(() => delivered.add(path));
    return first;
  });
}

/**
 * 경로들의 첫 응답이 훅에 건네질 때까지 기다린 뒤 화면에 반영합니다(QA-147). 카드 제목은 패널의 첫 요청보다 먼저 그려질 수
 * 있어, 제목만 보고 새로 읽으면 첫 요청이 버려집니다 — 값이 없을 때의 실패는 refreshError가 아니라 error입니다.
 */
async function firstResponsesShown(paths: string[]) {
  await waitFor(() => expect(paths.filter((path) => !delivered.has(path))).toEqual([]));
  await act(async () => {});
}

/**
 * 화면 전체 새로고침 신호(useApi가 따라 다시 읽음). 새 요소로 다시 그립니다 — 같은 요소를 넘기면 React가 렌더를
 * 건너뛰어 새 신호를 읽지 않습니다. 실패한 새로 읽기가 실제로 일어났는지(같은 경로 두 번째 요청)까지 확인합니다.
 */
async function refreshAll(rerender: (ui: ReactElement) => void, make: () => ReactElement, path: string) {
  signal.token += 1;
  await act(async () => rerender(make()));
  await waitFor(() =>
    expect(api.apiGetShared.mock.calls.filter(([called]) => called === path)).toHaveLength(2));
}

async function cardTitled(name: string) {
  const heading = await screen.findByRole("heading", { name });
  return heading.closest("section") as HTMLElement;
}

/**
 * 카드 제목을 넣은 커밋 바로 뒤(MutationObserver 마이크로태스크)에 끝납니다. 그 커밋이 마운트한 패널의 첫 요청 effect는
 * 아직 다음 Scheduler 작업에 남아 있습니다 — cardTitled가 가끔(부하가 높을수록 자주) 깨어나던 순간을 시간에 기대지 않고 만듭니다.
 */
function cardCommitted(name: string): Promise<HTMLElement> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const heading = [...document.querySelectorAll("h2")].find((h) => h.textContent === name);
      if (heading) {
        observer.disconnect();
        resolve(heading.closest("section") as HTMLElement);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

beforeEach(() => {
  // 블록으로 둡니다 — 화살표가 목 함수를 돌려주면 vitest가 그것을 정리 함수로 불러 끝나지 않는 요청을 기다립니다.
  api.apiGetShared.mockReset();
  signal.token = 0;
});
afterEach(() => cleanup());

// 대기(findBy·waitFor) 한도 5초, 테스트 하나의 한도 20초(1800bae, 기본 1초·5초). 부하가 높을 때 상태 화면이 가끔 실패한 것은
// 느려서가 아니라 첫 값을 받기 전에 새로 읽은 탓이라(QA-147) 한도와 무관했습니다. 통과하는 테스트는 30ms 안에 끝나므로 여유로 둡니다.
describe("QA-067 자동 갱신 실패를 패널에 표시한다", { timeout: 20_000 }, () => {
  beforeAll(() => configure({ asyncUtilTimeout: 5_000 }));
  afterAll(() => configure({ asyncUtilTimeout: 1_000 }));

  const panels: { name: string; make: () => ReactElement; bodies: Record<string, unknown>; card: string }[] = [
    { name: "현물·선물 카드", make: () => <SpotFuturesCard />, card: "현물·선물 수급 동조 (외국인·기관·개인)",
      bodies: { "/api/krx/spot-futures": { available: true, rows: [] } } },
    { name: "시장 수급 패널", make: () => <MarketFlowsPanel market="KOSPI" />, card: "코스피 전체 투자자별 매매대금",
      bodies: { "/api/kr/investor-flows": { markets: {} } } },
    { name: "스크래핑 시세", make: () => <ScrapedSection />, card: "비공식 스크래핑 시세 비교",
      bodies: { "/api/macro/scraped": { available: true, items: [] } } },
    { name: "매크로 위험 지표", make: () => <MacroPage />, card: "신용 리스크, 은행권 및 시장 변동성",
      bodies: { "/api/macro/risk": {} } },
    { name: "매크로 심화 지표", make: () => <MacroPage />, card: "심화 매크로 지표",
      bodies: { "/api/macro/advanced": { order: [], latest: {}, derived: {} } } },
    { name: "KRX 투자주체별 선물 수급", make: () => <KrxPage />, card: "투자주체별 선물 수급",
      // 페이지는 선물 응답을 받기 전까지 전체를 로딩으로 그립니다. 확인할 경로(선물 수급)는 마지막에 둡니다.
      bodies: { "/api/krx/futures?days=60": { available: false }, "/api/krx/investor-trend": { available: false } } },
    { name: "상태 화면 오류·경고 로그", make: () => <StatusPage />, card: "수집 오류·경고 로그",
      bodies: { "/api/status": { readMode: "auto", collectorReachable: true },
                "/api/status/issues": { counts: { errors: 0, warnings: 0, recentGroups: 0, missingDatasets: 0 },
                                        collectorReachable: true, text: "" } } },
  ];

  for (const { name, make, bodies, card } of panels) {
    it(`${name}: 새로 읽기에 실패하면 '새로 읽지 못함'`, async () => {
      firstThenFail(bodies);
      const { rerender } = render(make());
      const section = await cardTitled(card);
      await firstResponsesShown(Object.keys(bodies));
      expect(within(section).queryByText(FAILED)).toBeNull();

      await refreshAll(rerender, make, Object.keys(bodies).at(-1) as string);

      expect(await within(section).findByText(FAILED)).toBeTruthy();
    });
  }

  it("상태 화면: 개요를 새로 읽지 못하면 머리말에 '새로 읽지 못함'", async () => {
    firstThenFail({ "/api/status": { readMode: "auto", collectorReachable: true } });
    const { rerender } = render(<StatusPage />);
    const header = (await screen.findByRole("heading", { name: "데이터 저장소 상태" })).closest("header") as HTMLElement;

    await refreshAll(rerender, () => <StatusPage />, "/api/status");

    expect(await within(header).findByText(FAILED)).toBeTruthy();
  });
});

describe("QA-104 자동 갱신하는 나머지 패널도 실패를 표시한다", () => {
  // QA-067이 고친 8곳 밖에서 refreshMs>0으로 자동 갱신하면서 refreshError를 받지도 그리지도 않던 9곳.
  // 원천(수집기·외부 API) 실패는 200 {available:false}로 와서 배너가 뜨므로, 여기서는 백엔드에 닿지 못한 경우로 재현합니다.
  const panels: { name: string; make: () => ReactElement; bodies: Record<string, unknown>; card: string; header?: boolean }[] = [
    { name: "국면(머리말)", make: () => <RegimePage />, card: "시장 국면", header: true,
      bodies: { [endpoints.insight.regime("5")]: { available: true, timeline: [] } } },
    { name: "상관", make: () => <CorrelationPage />, card: "비교할 지표",
      bodies: { [endpoints.insight.correlation({ x: "liquidity:net", y: "etf:QQQ", window: "60", years: "3", mode: "change" })]:
        { available: false, message: "표본이 부족합니다." } } },
    { name: "환율 비교", make: () => <FxCompareSection />, card: "환율·달러인덱스 비교",
      bodies: { [endpoints.macro.fx(["usdkrw", "dxy"], "1y", "index")]: { available: true, series: [], catalog: [] } } },
    { name: "레이더 공통 순매수", make: () => <RadarPage />, card: "외국인·기관 공통 순매수",
      bodies: { [endpoints.positioning.radarConsensus({ market: "KOSPI", tradeType: "순매수", intervalType: "TODAY", topN: "30" })]:
        { available: false, rows: [], message: "공통 종목이 없습니다." } } },
    { name: "종목 수급 지속성", make: () => <StockFlowsPanel rows={[{ code: "005930", name: "삼성전자" }]} />,
      card: "수급 지속성 — 며칠째 사고 있나 (종목별 20거래일)",
      bodies: { [endpoints.positioning.stockFlows("005930")]: { stocks: [], message: "아직 수집되지 않았습니다." } } },
    { name: "판정 성과", make: () => <TrackRecordSection tone={{}} />, card: "판정 성과",
      bodies: { [endpoints.insight.regimeTrackRecord("SPY")]: { available: false, locked: false, message: "가격이 부족합니다.",
        asset: "SPY", assetLabel: "S&P 500 (SPY)", assets: [{ ticker: "SPY", label: "S&P 500 (SPY)" }], horizons: [], limits: [] } } },
    { name: "판정 기록", make: () => <RegimeLogSection tone={{}} />, card: "판정 기록",
      bodies: { [endpoints.insight.regimeLog(60)]: { available: true, entries: [], count: 0 } } },
    { name: "알림함", make: () => <AlertsPage />, card: "알림함",
      // 규칙을 먼저 받아야 화면이 그려집니다. 확인할 경로(알림함)는 마지막에 둡니다.
      bodies: { [endpoints.alerts.rules]: { available: true, rules: [] },
                [endpoints.alerts.inbox(50)]: { available: true, unread: 0, items: [] } } },
    { name: "KRX 장중 수급 가속도", make: () => <KrxPage />, card: "장중 수급 가속도 (최근 30분)",
      bodies: { [endpoints.positioning.krxFutures(60)]: { available: false },
                [endpoints.positioning.krxInvestorTrend]: { available: false },
                [endpoints.positioning.krxIntraday(30)]: { available: true, foreignCurrent: 100, foreignChange: 10,
                  latestTime: "11:00", referenceTime: "10:30", dataDate: "2026-10-16" } } },
  ];

  for (const { name, make, bodies, card, header } of panels) {
    // 수정 전에는 refreshError를 받지 않아 앞서 받은 값이 표시 없이 그대로 남았다.
    it(`${name}: 새로 읽기에 실패하면 '새로 읽지 못함'`, async () => {
      firstThenFail(bodies);
      const { rerender } = render(make());
      const area = header
        ? (await screen.findByRole("heading", { name: card })).closest("header") as HTMLElement
        : await cardTitled(card);
      await firstResponsesShown(Object.keys(bodies));
      expect(within(area).queryByText(FAILED)).toBeNull();

      await refreshAll(rerender, make, Object.keys(bodies).at(-1) as string);

      expect(await within(area).findByText(FAILED, {}, { timeout: 500 })).toBeTruthy();
    });
  }
});

describe("QA-147 패널이 첫 값을 받은 뒤에 새로 읽는다(시험 흔들림)", () => {
  // 상태 화면은 개요 응답 뒤에야 오류·경고 로그 패널을 마운트하고, 패널의 첫 요청은 그 커밋 다음 Scheduler 작업에서 나갑니다.
  // 수정 전에는 카드 제목만 보고 새로 읽어, 첫 요청이 새로 읽기 신호 뒤 act 안에서 나가 곧바로 버려지고(abort) 값이 없는
  // 실패(error, '다시 시도')가 됐다(재현 커밋에서는 it.fails). cardTitled로는 부하가 없어도 0.4~1%, 부하가 높으면 더 자주 이 순서였습니다.
  it("상태 화면 오류·경고 로그: 카드가 막 그려진 직후에 새로 읽어도 '새로 읽지 못함'", async () => {
    const path = "/api/status/issues";
    const bodies = { "/api/status": { readMode: "auto", collectorReachable: true },
                     [path]: { counts: { errors: 0, warnings: 0, recentGroups: 0, missingDatasets: 0 },
                               collectorReachable: true, text: "" } };
    firstThenFail(bodies);
    const committed = cardCommitted("수집 오류·경고 로그");   // 그리기 전에 관찰을 겁니다
    const { rerender } = render(<StatusPage />);
    const section = await committed;
    await firstResponsesShown(Object.keys(bodies));

    await refreshAll(rerender, () => <StatusPage />, path);

    expect(await within(section).findByText(FAILED, {}, { timeout: 500 })).toBeTruthy();
  });
});
