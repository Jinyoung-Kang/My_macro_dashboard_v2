/**
 * 상관(/correlation)·국면(/regime) 화면의 조작·자동 갱신 실패 시험 — 두 공유 시험 파일에서 두 화면 사례만 옮겨 왔습니다(P5a 패턴 단계, 내용 그대로).
 *
 * 원래 파일·describe 이름 그대로 옮김:
 *  - controlsStay.test.tsx: 'QA-047 조건을 바꿔도 컨트롤이 남는다'(사례 배열의 국면),
 *    'QA-066 페이지 조건을 바꿔도 스스로 읽는 하위 섹션의 선택이 남는다'(국면 — 판정 성과의 관점),
 *    'QA-101 판정 성과 — 자산을 바꿔도 선택지가 줄지 않는다'(둘)
 *  - refreshErrors.test.tsx: 'QA-104 자동 갱신하는 나머지 패널도 실패를 표시한다'(국면 머리말·상관·판정 성과·판정 기록)
 * 도우미 함수는 원래 파일의 것을 글자 그대로 복사했습니다. 세 화면 갈래(매크로 · 순유동성·섹터·COT · 상관·국면)가 화면을 바꿀 때 서로의 시험 파일을
 * 고치지 않게 갈래마다 파일을 나눈 것입니다(나머지 사례는 원래 파일에 남음).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { endpoints } from "@/lib/endpoints";
import CorrelationPage from "../correlation/page";
import RegimePage from "../regime/page";
import { RegimeLogSection } from "../regime/RegimeLogSection";
import { TrackRecordSection } from "../regime/TrackRecordSection";

/** 첫 경로만 응답하고, 바꾼 뒤의 경로는 끝나지 않는 요청(로딩 중). */
function answerOnly(firstPath: string, body: unknown) {
  api.apiGetShared.mockImplementation((path: string) =>
    path === firstPath ? Promise.resolve(body) : new Promise(() => {}));
}

const FAILED = "새로 읽지 못함";

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

// refreshErrors의 beforeEach 그대로입니다 — controlsStay의 beforeEach(조회 목 초기화)를 담습니다.
beforeEach(() => {
  // 블록으로 둡니다 — 화살표가 목 함수를 돌려주면 vitest가 그것을 정리 함수로 불러 끝나지 않는 요청을 기다립니다.
  api.apiGetShared.mockReset();
  signal.token = 0;
});
afterEach(() => cleanup());

describe("QA-047 조건을 바꿔도 컨트롤이 남는다", () => {
  const cases = [
    { name: "국면", Page: RegimePage, path: "/api/analytics/regime?years=5", label: "이력 기간", next: "10",
      body: { available: true, timeline: [] } },
  ];

  for (const { name, Page, path, label, next, body } of cases) {
    // 수정 전에는 로딩 중 페이지 전체를 바꿔 선택 상자가 사라졌다.
    it(`${name}: 기간을 바꾼 뒤 새 응답을 기다리는 동안에도 '${label}' 선택 상자가 그대로`, async () => {
      answerOnly(path, body);
      render(<Page />);
      const select = (await screen.findByLabelText(label)) as HTMLSelectElement;

      fireEvent.change(select, { target: { value: next } });

      expect(select.isConnected).toBe(true);
      expect((screen.getByLabelText(label) as HTMLSelectElement).value).toBe(next);
    });
  }
});

describe("QA-066 페이지 조건을 바꿔도 스스로 읽는 하위 섹션의 선택이 남는다", () => {
  // 수정 전에는 페이지 데이터가 비는 동안 `{data && …}`가 하위 섹션까지 내려 선택이 처음으로 돌아갔다(it.fails).
  it("국면: 이력 기간을 바꿔도 판정 성과의 '관점' 선택이 그대로", async () => {
    answerOnly("/api/analytics/regime?years=5", { available: true, timeline: [] });
    render(<RegimePage />);
    const view = (await screen.findByLabelText("관점")) as HTMLSelectElement;
    fireEvent.change(view, { target: { value: "all" } });

    fireEvent.change(screen.getByLabelText("이력 기간"), { target: { value: "10" } });

    expect(view.isConnected).toBe(true);
    expect((screen.getByLabelText("관점") as HTMLSelectElement).value).toBe("all");
  });
});

describe("QA-101 판정 성과 — 자산을 바꿔도 선택지가 줄지 않는다", () => {
  const ASSETS = [
    { ticker: "SPY", label: "S&P 500 (SPY)" },
    { ticker: "QQQ", label: "나스닥 100 (QQQ)" },
    { ticker: "IEF", label: "미국채 7-10년 (IEF)" },
  ];
  const SPY = "/api/analytics/regime/track-record?asset=SPY";
  const body = { available: false, locked: false, message: "", asset: "SPY", assetLabel: "S&P 500 (SPY)",
                 assets: ASSETS, horizons: [], limits: [] };

  async function chooseIef() {
    render(<TrackRecordSection tone={{}} />);
    await screen.findByRole("option", { name: "미국채 7-10년 (IEF)" });
    fireEvent.change(screen.getByLabelText("자산"), { target: { value: "IEF" } });
  }

  // 수정 전에는 새 자산의 응답을 기다리는 동안 선택지가 SPY 하나로 줄어, 요청은 IEF인데 선택 상자는 SPY를 보였다.
  it("새 자산을 읽는 동안에도 선택 상자가 고른 자산을 보이고 선택지가 그대로", async () => {
    answerOnly(SPY, body);
    await chooseIef();

    const select = screen.getByLabelText("자산") as HTMLSelectElement;
    expect(select.value).toBe("IEF");
    expect(select.options).toHaveLength(3);
  });

  // 수정 전에는 실패하면 선택지가 SPY 하나(이미 선택된 상태)로 남아, SPY를 다시 골라도 change가 나지 않았다.
  it("새 자산 읽기가 실패해도 선택지가 남아 SPY로 돌아갈 수 있다", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path === SPY ? Promise.resolve(body) : Promise.reject(new Error("요청 실패 (HTTP 502)")));
    await chooseIef();
    await screen.findByText(/HTTP 502/);

    const select = screen.getByLabelText("자산") as HTMLSelectElement;
    expect(select.value).toBe("IEF");
    expect(select.options).toHaveLength(3);
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
    { name: "판정 성과", make: () => <TrackRecordSection tone={{}} />, card: "판정 성과",
      bodies: { [endpoints.insight.regimeTrackRecord("SPY")]: { available: false, locked: false, message: "가격이 부족합니다.",
        asset: "SPY", assetLabel: "S&P 500 (SPY)", assets: [{ ticker: "SPY", label: "S&P 500 (SPY)" }], horizons: [], limits: [] } } },
    { name: "판정 기록", make: () => <RegimeLogSection />, card: "판정 기록",
      bodies: { [endpoints.insight.regimeLog(60)]: { available: true, entries: [], count: 0 } } },
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
