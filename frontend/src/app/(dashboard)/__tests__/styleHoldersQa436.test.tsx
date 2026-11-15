/**
 * 스타일·위험 화면의 '이 종목을 누가 들고 있나' 직접 검색 — 공용 경로 GET /api/guru/holders의 일치 규칙(QA-436)에 맞춘 안내. 응답은 모두 합성 값입니다.
 *
 * QA-436이 일치 규칙을 '공시 이름에 검색어가 들어감'에서 '잘린 공시 이름(24자 이상)의 앞부분으로 검색어가 시작함'까지 넓혀, 검색어가 들어가지 않은 잘린
 * 공시 이름과 펀드 묶음 이름 줄도 함께 걸립니다. 같은 경로를 쓰는 정보 검색 보유 탭·종목 상세는 그렇게 알리고 0건이면 없다고 단정하지 않는데, 이 화면만
 * '종목명 일부'·포함 규칙 그대로였고 0건이면 백엔드 글('그 이름을 포함한 보유 종목이 없습니다')로 없다고 단정했습니다.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

const QUERY = "SYNTHETIC EXAMPLE FINANCIAL GROUP";

function search(response: object, query: string) {
  api.apiGetShared.mockImplementation((path: string) =>
    path.startsWith("/api/guru/holders") ? Promise.resolve(response) : new Promise(() => {}));
  render(<GuruPage />);
  fireEvent.change(screen.getByPlaceholderText("NVIDIA"), { target: { value: query } });
  fireEvent.click(screen.getByRole("button", { name: "찾기" }));
}

describe("스타일 화면 보유 기관 검색 — QA-436 일치 규칙에 맞춘 안내(QA-436 후속)", () => {
  // QA-436 후속: 검색어가 들어가지 않은 잘린 공시 이름 줄('…FINANCIAL GRO')이 설명 없이 보였고, 칸 이름은 '종목명 일부'(포함 규칙)였습니다.
  // 수정 전 실패: '잘린 공시 이름'·'섞일 수 있' 안내가 없고 칸 이름이 '종목명 일부'(재현 커밋에서는 it.fails).
  it.fails("줄이 있으면 잘린 공시 이름도 함께 찾아 다른 종목이 섞일 수 있다는 것을 적고, 칸 이름이 포함 규칙만 말하지 않는다", async () => {
    search({
      available: true, query: QUERY, totalMatches: 1, truncated: false,
      rows: [{ institution: "합성 자산운용", cik: "0000000001", name: "SYNTHETIC EXAMPLE FINANCIAL GRO", cusip: "000000101", weight: 1.25,
        value: 1_000_000, reportDate: "2026-06-30" }],
    }, QUERY);

    const card = screen.getByRole("heading", { name: "이 종목을 누가 들고 있나" }).closest("section") as HTMLElement;
    await within(card).findByText("SYNTHETIC EXAMPLE FINANCIAL GRO");
    // 결과 위의 안내 한 줄 — 무엇을 함께 찾는지와 그래서 다른 종목이 섞일 수 있다는 것.
    const note = within(card).getByText(/잘린 공시 이름/);
    expect(note.textContent).toMatch(/섞일 수 있/);
    expect(within(card).queryByText("종목명 일부")).toBeNull();
  });

  // QA-436 후속: 0건이면 백엔드의 '그 이름을 포함한 보유 종목이 없습니다'를 그대로 보여, 줄여 적은 공시 이름(FINANCIAL → FINL)이라 못 찾은 경우에도
  // 없다고 단정했습니다. 수정 전 실패: 백엔드 글이 보이고 '단정할 수 없습니다'가 없음(재현 커밋에서는 it.fails).
  it.fails("0건이면 찾은 이름과 그 한계를 적고 없다고 단정하지 않는다(정보 검색 보유 탭·종목 상세와 같은 글)", async () => {
    const query = "SYNTHETIC KAPPA MOTOR CORPORATION";
    search({
      available: false, query, rows: [], totalMatches: 0, truncated: false,
      message: "그 이름을 포함한 보유 종목이 없습니다. 13F 공시 이름은 대문자 영문입니다(예: APPLE, NVIDIA).",
    }, query);

    const card = screen.getByRole("heading", { name: "이 종목을 누가 들고 있나" }).closest("section") as HTMLElement;
    // 응답을 그릴 때까지 기다립니다 — 수정 전(백엔드 글)이든 수정 뒤(이 화면의 글)든 같은 기다림입니다.
    await within(card).findByText(/보유 종목이 없습니다|보유 줄이 없습니다/);

    // 결함을 직접 보는 단언 먼저(수정 전에는 여기서 실패) — 포함 규칙으로 없다고 단정하는 백엔드 글이 없어야 합니다.
    expect(within(card).queryByText(/포함한 보유 종목이 없습니다/)).toBeNull();
    const status = within(card).getByRole("status");
    expect(status.textContent).toContain(`‘${query}’ 이름으로 찾은 13F 보유 줄이 없습니다`);
    expect(status.textContent).toContain("보유한 곳이 없다고 단정할 수 없습니다");
  });
});
