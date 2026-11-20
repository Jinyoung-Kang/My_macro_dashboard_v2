/**
 * QA-943(작업대 결정 거리 sector-error-plus-empty-message — P8): /sector 첫 읽기가 실패하면 페이지 위 오류 상자(이유·다시 시도) 아래 '섹터 모멘텀' 패널이
 * 빈 막대 차트의 '표시할 데이터가 없습니다.'를 함께 보입니다 — 패널 조건식이 읽는 중만 보고 오류를 보지 않아, 받지 못한 것을 '자료 없음'으로 읽게 했습니다
 * (매크로 금리차 패널은 실패와 자료 없음을 가름).
 *
 * 기대: 값 없이 실패하면 패널에 빈 차트·'표시할 데이터가 없습니다.'가 없고, 읽지 못했다는 한 줄만(이유·다시 시도는 위 오류 상자 하나). 받은 값이 있는 채
 * 다시 읽기만 실패하면 막대는 그대로입니다.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 'expected <div …>표시할 데이터가 없습니다.</div> to be null'.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), apiBase: () => "http://backend", UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
// 막대 차트 — 실제 HorizontalBars처럼 행이 없으면 빈 상태 글을 그립니다(jsdom은 크기가 없어 그림을 그리지 않음).
vi.mock("@/components/charts", () => ({
  HorizontalBars: ({ data }: { data: unknown[] }) =>
    data.length === 0 ? <div>표시할 데이터가 없습니다.</div> : <div data-chart="bars" data-count={data.length} />,
}));

import SectorPage from "../sector/page";

class SilentEventSource {
  onerror: (() => void) | null = null;
  addEventListener() {}
  close() {}
}

beforeEach(() => {
  vi.stubGlobal("EventSource", SilentEventSource);
  api.apiGetShared.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** '섹터 모멘텀' 패널 — 제목(h2)을 품은 가장 가까운 section. */
async function momentumPanel(): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { name: "섹터 모멘텀" });
  return heading.closest("section") as HTMLElement;
}

describe("QA-943 /sector 읽기 실패 때 섹터 모멘텀 패널", () => {
  it.fails("값 없이 실패하면 패널에 빈 차트·'표시할 데이터가 없습니다.'가 없고 읽지 못했다는 한 줄 — 오류 상자는 위에 하나", async () => {
    api.apiGetShared.mockImplementation(() => Promise.reject(new Error("합성 실패 503")));
    render(<SectorPage />);
    expect(await screen.findByRole("button", { name: "다시 시도" })).toBeTruthy();
    const panel = await momentumPanel();
    expect(within(panel).queryByText("표시할 데이터가 없습니다.")).toBeNull();
    expect(within(panel).getByText(/읽지 못/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "다시 시도" })).toHaveLength(1);
  });

  it("받은 목록이 비었으면 그때는 '표시할 데이터가 없습니다.'(자료 없음 — 오류 상자 없음)", async () => {
    api.apiGetShared.mockImplementation(() =>
      Promise.resolve({ available: true, periods: ["1M"], period: "1M", benchmark: "SPY", benchmarkReturns: {}, sectors: [], assetClasses: [] }),
    );
    render(<SectorPage />);
    const panel = await momentumPanel();
    // 받은 목록이 비었으면 그때는 '자료 없음'이 맞습니다.
    expect(await within(panel).findByText("표시할 데이터가 없습니다.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
  });
});
