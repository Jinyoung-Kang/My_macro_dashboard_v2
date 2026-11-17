/**
 * 매크로 화면(/macro)의 조작·정직한 상태·자동 갱신 실패 시험 — 세 공유 시험 파일에서 매크로 사례만 옮겨 왔습니다(P5a 패턴 단계, 내용 그대로).
 *
 * 원래 파일·describe 이름 그대로 옮김:
 *  - controlsStay.test.tsx: 'QA-047 조건을 바꿔도 컨트롤이 남는다'(매크로 자동 갱신 간격·환율 비교 계열 버튼),
 *    'QA-066 페이지 조건을 바꿔도 스스로 읽는 하위 섹션의 선택이 남는다'(매크로 — 환율 비교에서 켠 계열)
 *  - honestStates.test.tsx: 'QA-099 지표별 단독 차트 — 백엔드가 받지 못한 이유를 보인다'(둘),
 *    'QA-103 첫 조회·버튼 동작이 실패하면 이유를 보인다'(스크래핑 시세·매크로 심화 지표 줄)
 *  - refreshErrors.test.tsx: 'QA-067 자동 갱신 실패를 패널에 표시한다'(스크래핑 시세·매크로 위험·매크로 심화),
 *    'QA-104 자동 갱신하는 나머지 패널도 실패를 표시한다'(환율 비교)
 * 도우미 함수는 원래 파일의 것을 글자 그대로 복사했습니다. 세 화면 갈래(매크로 · 순유동성·섹터·COT · 상관·국면)가 화면을 바꿀 때 서로의 시험 파일을
 * 고치지 않게 갈래마다 파일을 나눈 것입니다(나머지 사례는 원래 파일에 남음).
 */
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 함수를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { endpoints } from "@/lib/endpoints";
import { MACRO_SECTIONS } from "@/lib/marketSections";
import { FxCompareSection } from "../macro/FxCompareSection";
import MacroPage from "../macro/page";
import { ScrapedSection } from "../macro/ScrapedSection";
import { SingleChartSection } from "../macro/SingleChartSection";

/** 첫 경로만 응답하고, 바꾼 뒤의 경로는 끝나지 않는 요청(로딩 중). */
function answerOnly(firstPath: string, body: unknown) {
  api.apiGetShared.mockImplementation((path: string) =>
    path === firstPath ? Promise.resolve(body) : new Promise(() => {}));
}

/** 경로 앞부분 → 응답(함수면 거절할 수도 있음). 없는 경로는 끝나지 않는 요청. */
let reads: Record<string, () => Promise<unknown>> = {};

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

// 세 원래 파일의 beforeEach를 합쳤습니다 — controlsStay(조회 목 초기화), refreshErrors(조회 목 초기화·새로고침 신호 0), honestStates(reads 비우기·
// 쓰기 목 초기화·조회 목의 기본 = reads의 앞부분이 맞는 경로만 답하고 나머지는 끝나지 않는 요청). controlsStay·refreshErrors에서 옮긴 시험은
// 조회 목을 스스로 정하므로(answerOnly·firstThenFail·mockImplementation) 기본은 honestStates에서 옮긴 시험만 씁니다.
beforeEach(() => {
  // 블록으로 둡니다 — 화살표가 목 함수를 돌려주면 vitest가 그것을 정리 함수로 불러 끝나지 않는 요청을 기다립니다.
  reads = {};
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  signal.token = 0;
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
});
afterEach(() => cleanup());

describe("QA-047 조건을 바꿔도 컨트롤이 남는다", () => {
  it("매크로: 자동 갱신 간격이 1분 경계를 넘어(live 경로가 바뀜) 새 응답을 기다리는 동안에도 선택 상자가 그대로", async () => {
    answerOnly("/api/macro/overview?live=true", { available: true, categories: [] });   // 기본 간격은 1분 이하
    render(<MacroPage />);
    const select = (await screen.findByLabelText("자동 갱신 간격")) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "300" } });

    expect(select.isConnected).toBe(true);
  });

  it("환율 비교: 계열을 켜고 새 응답을 기다리는 동안에도 계열 버튼이 그대로", async () => {
    let first = true;
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/macro/fx") && first) {
        first = false;
        return Promise.resolve({ available: true, series: [], catalog: [
          { id: "usdkrw", label: "원/달러" }, { id: "dxy", label: "달러 인덱스" }, { id: "usdjpy", label: "엔/달러" }] });
      }
      return new Promise(() => {});
    });
    render(<FxCompareSection />);
    const button = await screen.findByRole("button", { name: "엔/달러" });

    fireEvent.click(button);

    expect(button.isConnected).toBe(true);
  });
});

describe("QA-066 페이지 조건을 바꿔도 스스로 읽는 하위 섹션의 선택이 남는다", () => {
  it("매크로: 자동 갱신 간격이 1분 경계를 넘어도 환율 비교에서 켠 계열이 그대로", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path === "/api/macro/overview?live=true") return Promise.resolve({ available: true, categories: [] });
      if (path.startsWith("/api/macro/fx")) {
        return Promise.resolve({ available: true, series: [], catalog: [
          { id: "usdkrw", label: "원/달러" }, { id: "dxy", label: "달러 인덱스" }, { id: "usdjpy", label: "엔/달러" }] });
      }
      return new Promise(() => {});
    });
    render(<MacroPage />);
    const button = await screen.findByRole("button", { name: "엔/달러" });
    fireEvent.click(button);
    const pressed = button.getAttribute("aria-pressed");

    fireEvent.change(screen.getByLabelText("자동 갱신 간격"), { target: { value: "300" } });

    expect(button.isConnected).toBe(true);
    expect(screen.getByRole("button", { name: "엔/달러" }).getAttribute("aria-pressed")).toBe(pressed);
  });
});

describe("QA-099 지표별 단독 차트 — 백엔드가 받지 못한 이유를 보인다", () => {
  // 수정 전에는 available·message를 보지 않아, 공개 데모(store_only)에서 10개 중 8개 지표가 이유 없이
  // '표시할 시계열이 없습니다'만 보였다(수집기 실패 사유도 같은 식으로 버려졌다).
  it.each([
    "store_only 모드에서는 저장하지 않는 지표의 차트를 조회하지 않습니다.",
    "수집기에서 시계열을 받지 못했습니다.",
  ])("응답이 '%s'이면 그 문구를 보이고 빈 차트를 그리지 않는다", async (message) => {
    reads["/api/macro/ticker"] = () => Promise.resolve({ available: false, symbol: "^VIX", points: [], message });

    render(<SingleChartSection />);

    expect(await screen.findByText(message, {}, { timeout: 500 })).toBeTruthy();
    expect(screen.queryByText("표시할 시계열이 없습니다.")).toBeNull();
  });
});

describe("QA-103 첫 조회·버튼 동작이 실패하면 이유를 보인다", () => {
  const FAILED = "요청 실패 (HTTP 503)";
  // 수정 전에는 error를 받지 않거나(스크래핑·AI 엔진 목록) 섹션에 넘기지 않아(심화 지표) 빈 카드·이유 없이 꺼진 버튼만 남았다.
  it.each<[string, string, () => ReactElement]>([
    ["스크래핑 시세", "/api/macro/scraped", () => <ScrapedSection />],
    ["매크로 심화 지표", "/api/macro/advanced", () => <MacroPage />],
  ])("%s: 첫 조회가 실패하면 오류와 다시 시도", async (_name, path, make) => {
    reads[path] = () => Promise.reject(new Error(FAILED));

    render(make());

    expect(await screen.findByText(FAILED)).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
  });

  // QA-670: 신용·변동성 패널은 첫 조회가 실패해도 사유를 버리고 회색 빈 상태 글('리스크 지표를 불러오지 못했습니다.')만 그려, 다시 시도 단추가 없었습니다
  // (개편 전부터 — QA-103이 심화 지표만 고침). 자동 갱신 '끄기'면 새로 고침 말고는 다시 읽을 길이 없었습니다(QA 스택, 모의 500). 심화 지표와 같이
  // 이유와 다시 시도를 보이고, 누르면 한 번 더 읽어야 합니다.
  // 수정 전(재현 커밋에서는 it.fails)에는 패널에 '리스크 지표를 불러오지 못했습니다.'만 있어 사유를 찾지 못했습니다('Unable to find an element with the text: 요청 실패 (HTTP 503)').
  it.fails("매크로 신용·변동성: 첫 조회가 실패하면 오류와 다시 시도 — 누르면 /api/macro/risk를 한 번 더 읽는다", async () => {
    reads["/api/macro/risk"] = () => Promise.reject(new Error(FAILED));
    render(<MacroPage />);

    const section = (await screen.findByRole("heading", { name: "신용 리스크, 은행권 및 시장 변동성" })).closest("section") as HTMLElement;
    expect(await within(section).findByText(FAILED)).toBeTruthy();
    const riskReads = () => api.apiGetShared.mock.calls.filter(([called]) => String(called).startsWith("/api/macro/risk")).length;
    const before = riskReads();
    fireEvent.click(within(section).getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(riskReads()).toBe(before + 1));
  });
});

// 대기(findBy·waitFor) 한도 5초, 테스트 하나의 한도 20초(1800bae, 기본 1초·5초). 부하가 높을 때 상태 화면이 가끔 실패한 것은
// 느려서가 아니라 첫 값을 받기 전에 새로 읽은 탓이라(QA-147) 한도와 무관했습니다. 통과하는 테스트는 30ms 안에 끝나므로 여유로 둡니다.
describe("QA-067 자동 갱신 실패를 패널에 표시한다", { timeout: 20_000 }, () => {
  beforeAll(() => configure({ asyncUtilTimeout: 5_000 }));
  afterAll(() => configure({ asyncUtilTimeout: 1_000 }));

  const panels: { name: string; make: () => ReactElement; bodies: Record<string, unknown>; card: string }[] = [
    { name: "스크래핑 시세", make: () => <ScrapedSection />, card: "비공식 스크래핑 시세 비교",
      bodies: { "/api/macro/scraped": { available: true, items: [] } } },
    { name: "매크로 위험 지표", make: () => <MacroPage />, card: "신용 리스크, 은행권 및 시장 변동성",
      bodies: { "/api/macro/risk": {} } },
    { name: "매크로 심화 지표", make: () => <MacroPage />, card: "심화 매크로 지표",
      bodies: { "/api/macro/advanced": { order: [], latest: {}, derived: {} } } },
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
});

describe("QA-104 자동 갱신하는 나머지 패널도 실패를 표시한다", () => {
  // QA-067이 고친 8곳 밖에서 refreshMs>0으로 자동 갱신하면서 refreshError를 받지도 그리지도 않던 9곳.
  // 원천(수집기·외부 API) 실패는 200 {available:false}로 와서 배너가 뜨므로, 여기서는 백엔드에 닿지 못한 경우로 재현합니다.
  const panels: { name: string; make: () => ReactElement; bodies: Record<string, unknown>; card: string; header?: boolean }[] = [
    { name: "환율 비교", make: () => <FxCompareSection />, card: "환율·달러인덱스 비교",
      bodies: { [endpoints.macro.fx(["usdkrw", "dxy"], "1y", "index")]: { available: true, series: [], catalog: [] } } },
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

// QA-668: 저장본이 없을 때(백엔드 MacroService.overview — available=false, categories는 빈 목록) 목차 첫 칸이 '지표 (0)'·지표 패널 머리가 '지표 0개'라,
// 모르는 개수를 0으로 적었습니다(QA 스택 1440·390, 합성 개요 — '없는 숫자를 만들지 않는다'). 개요를 받기 전과 같이 개수 없이 두어야 하고, 저장본 없음
// 안내는 그대로여야 합니다. 저장본이 있는데 범주가 비면(available=true) 지금처럼 '0개'입니다(위 QA-047·QA-066 시험의 응답).
describe("QA-668 저장본 없음이면 지표 개수를 0으로 적지 않는다", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 패널 머리 '0개'('expected [ <span …(1)></span> ] to deeply equal []')·목차 링크 이름 '지표 (0)'이었습니다.
  it("available=false — 목차 첫 칸 이름이 '지표'(개수 없음), 지표 패널에 'n개' 없음, 저장본 없음 안내는 그대로", async () => {
    reads["/api/macro/overview"] = () => Promise.resolve({ available: false, readMode: "cache", categories: [], message: "저장본 없음" });
    render(<MacroPage />);

    const section = document.getElementById(MACRO_SECTIONS.indicators) as HTMLElement;
    expect(await within(section).findByText("저장본 없음")).toBeTruthy();
    expect(within(section).queryAllByText(/\d개$/)).toEqual([]);

    const nav = screen.getByRole("navigation", { name: "매크로 지표 목차" });
    const first = within(nav).getAllByRole("link")[0];
    expect(within(nav).getAllByRole("link", { name: "지표" })[0]).toBe(first);
    expect(within(nav).queryAllByRole("link", { name: /^지표 \(/ })).toEqual([]);
  });
});
