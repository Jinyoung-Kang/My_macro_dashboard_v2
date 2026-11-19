/**
 * 정보 수집 국내 KRX 절의 빈 표 — QA-877(작업대 P7 검토에서 찾음, 브라우저 측정).
 *
 * KRX 절(Paged)은 행이 없어도 공용 조밀 표를 그려, 390에서 빈 'KRX 외국인 순매수 상위 · 코스피' 표의 머리 칸(순위·종목·순매수 금액·순매수 수량·매수·매도)이
 * 스크롤 상자(332px)를 넘쳤는데(463px) 넘김 안내가 없었습니다 — 공용 표는 행이 있을 때만 최소 폭과 안내를 둡니다(QA-503 기록). '순매수 수량'의 오른쪽 절반과
 * '매수'·'매도' 머리가 단서 없이 잘렸습니다(기준 빌드는 같은 자리에 넘침 없음).
 *
 * 기대: 행이 없으면 표(머리 줄) 대신 같은 문구의 빈 상태 한 줄 — 넘칠 머리가 없습니다. 행이 있으면 예전 그대로 조밀 표.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 'expected <div …(4)>…(1)</div> to be null'(빈 순위의 머리 줄 표가 그려짐).
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { KrxSection } from "../KrxSection";

const EMPTY_KRX = {
  available: false,
  ranking: { market: "KOSPI", investor: "외국인", tradeType: "순매수", date: null, rows: [] },
  markets: ["KOSPI", "KOSDAQ"],
  investors: ["외국인"],
};

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path.startsWith("/api/info/krx") ? Promise.resolve(EMPTY_KRX) : new Promise(() => {})));
});
afterEach(() => cleanup());

describe("KRX 절의 빈 표(QA-877)", () => {
  it("받은 순위가 없으면 머리 줄 표 대신 빈 상태 한 줄 — 넘칠 머리가 없음", async () => {
    render(<KrxSection />);
    await screen.findByText(/받은 순위 없음/);
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "KRX 외국인 순매수 상위 · 코스피 (좌우 스크롤)" })).toBeNull();
    expect(screen.getByText("자료가 없습니다.")).toBeTruthy();
  });
});
