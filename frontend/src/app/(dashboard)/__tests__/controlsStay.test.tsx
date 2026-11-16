/**
 * 기간·조건을 바꿔도 그 컨트롤은 화면에 남는다(QA-047).
 *
 * 화면이 `loading && !data`면 페이지 전체를 로딩 표시로 바꿔, 방금 조작한 선택 상자가 사라지고 키보드 포커스가
 * 문서 맨 앞으로 갔습니다(닫힌 select에서 화살표로 고르는 사용자는 한 칸마다 처음부터 다시 Tab). 새 요청이 끝나기
 * 전에도 선택 상자는 그대로 있어야 합니다.
 *
 * 시장 화면(매크로·순유동성·섹터·국면 — P5a)의 사례는 갈래별 파일로 옮겼습니다(내용 그대로): macroScreenStates·liquiditySectorCotStates·
 * correlationRegimeStates(.test.tsx).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import ConsensusPage from "../consensus/page";

beforeEach(() => {
  // 블록으로 둡니다 — 화살표가 목 함수를 돌려주면 vitest가 그것을 정리 함수로 불러 끝나지 않는 요청을 기다립니다.
  api.apiGetShared.mockReset();
});
afterEach(() => cleanup());

describe("QA-047 조건을 바꿔도 컨트롤이 남는다", () => {
  it("13F 교집합: 기준 분기를 고르고 새 응답을 기다리는 동안 선택 상자가 고른 분기를 그대로 보인다", async () => {
    let first = true;
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/consensus") && first) {
        first = false;
        return Promise.resolve({ available: false, availableDates: ["2026-06-30", "2026-03-31"], rows: [] });
      }
      return new Promise(() => {});
    });
    render(<ConsensusPage />);
    await screen.findByRole("option", { name: "2026-03-31" });
    const select = screen.getByLabelText("기준 분기") as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "2026-03-31" } });

    // 응답을 기다리는 동안 선택지가 '최신 분기' 하나로 줄면 화면은 최신을 보이는데 요청은 고른 분기로 나갔습니다.
    expect((screen.getByLabelText("기준 분기") as HTMLSelectElement).value).toBe("2026-03-31");
  });
});
