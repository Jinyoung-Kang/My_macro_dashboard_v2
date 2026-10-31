/**
 * QA-153 스타일 화면 '기관 간 유사도'의 짧은 이름에 국기가 남는다.
 *
 * 기관 이름은 백엔드가 앞에 국기를 붙여 내려 줍니다('[국기] 버크셔 해서웨이 (Berkshire Hathaway)'). 행렬의 머리·행 이름과 짝 순위는
 * 짧은 이름(shortName — 앞 그림 문자와 끝 괄호를 뗌)을 쓰는데, 그 정규식이 그림 문자(Extended_Pictographic)만 보고 국기를 이루는
 * 지역 표시 문자(Regional_Indicator)는 보지 않아 국기가 그대로 남았습니다('[국기] 버크셔 해서웨이'). 국기 글꼴이 없는 Windows에서는
 * 'US 버크셔 해서웨이'로 보입니다.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import GuruPage from "../style/page";

afterEach(() => cleanup());

const SIMILARITY = {
  available: true,
  institutions: [
    { cik: "0001067983", key: "berkshire", name: "🇺🇸 버크셔 해서웨이 (Berkshire Hathaway)", reportDate: "2026-06-30" },
    { cik: "0001374170", key: "norges", name: "🇳🇴 노르웨이 국부펀드 (Norges Bank / GPFG)", reportDate: "2026-06-30" },
  ],
  overlap: [[100, 12.5], [12.5, 100]],
  cosine: [[1, 0.31], [0.31, 1]],
  topPairs: [],
};

describe("QA-153 유사도 행렬의 짧은 이름", () => {
  // 수정 전에는 shortName이 지역 표시 문자를 떼지 않아 머리·행 이름·짝 순위가 '[국기] 버크셔 해서웨이'였다.
  it.fails("행렬 머리·행 이름과 짝 순위는 국기를 뗀 짧은 이름 — 전체 이름(마우스 설명)에도 국기가 없다", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith("/api/guru/similarity") ? Promise.resolve(SIMILARITY) : new Promise(() => {}));
    render(<GuruPage />);

    const matrix = await screen.findByRole("region", { name: "기관 간 유사도 행렬 (좌우 스크롤)" });
    expect(within(matrix).getAllByText("버크셔 해서웨이")).toHaveLength(2);   // 열 머리 + 행 이름
    expect(within(matrix).getAllByText("노르웨이 국부펀드")).toHaveLength(2);
    expect(within(matrix).getAllByTitle("버크셔 해서웨이 (Berkshire Hathaway)")).toHaveLength(2);
    // 짝 순위(행렬에서 만든 목록)도 같은 짧은 이름
    expect(screen.getAllByText("버크셔 해서웨이").length).toBeGreaterThan(2);
    expect(document.body.textContent).not.toMatch(/\p{Regional_Indicator}/u);
  });
});
