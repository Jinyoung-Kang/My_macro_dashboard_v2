/**
 * 매크로 화면(/macro) — 작업대 화면 언어 P5a 배치에서 고정하는 것.
 *  - 원본 데이터: 화면 머리의 동작 둘('원본 데이터 보기' 대화상자·'원본 데이터 복사'), 열 때만 읽음, 생성 시각·글자 수·다시 읽기·오류와 다시 시도
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), apiBase: () => "http://backend", UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import MacroPage from "../macro/page";

const SNAPSHOT_PATH = "/api/snapshot/text";

/** 경로 앞부분 → 응답(함수면 부를 때마다 새로). 없는 경로는 끝나지 않는 요청. */
let reads: Record<string, () => Promise<unknown>> = {};

function snapshotCalls(): number {
  return api.apiGetShared.mock.calls.filter(([path]) => path === SNAPSHOT_PATH).length;
}

beforeEach(() => {
  reads = {};
  window.localStorage.clear();
  api.apiGet.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("원본 데이터 — 화면 머리 동작", () => {
  it("'원본 데이터 보기'는 대화상자 단추이고 열기 전에는 읽지 않는다 — 열면 생성 시각·글자 수·본문, 닫으면 연 단추로 돌아온다", async () => {
    reads[SNAPSHOT_PATH] = () => Promise.resolve({ text: "== 매크로 ==\n원/달러 1,389.46", chars: 1234, generatedAtKst: "2026-11-17 06:31 KST" });
    render(<MacroPage />);

    const header = screen.getByRole("heading", { level: 1, name: "거시경제 매크로 지표" }).closest("header") as HTMLElement;
    const open = within(header).getByRole("button", { name: "원본 데이터 보기" });
    expect(open.getAttribute("aria-haspopup")).toBe("dialog");
    expect(within(header).getByRole("button", { name: "원본 데이터 복사" })).toBeTruthy();
    expect(snapshotCalls()).toBe(0);

    fireEvent.click(open);
    const dialog = await screen.findByRole("dialog", { name: "전체 대시보드 원본 데이터" });
    expect(await within(dialog).findByText(/원\/달러 1,389\.46/)).toBeTruthy();
    expect(within(dialog).getByText("2026-11-17 06:31 생성 · 1,234자")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "다시 읽기" })).toBeTruthy();
    expect(snapshotCalls()).toBe(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(open);
  });

  it("'다시 읽기'는 한 번 더 읽는다 — 첫 읽기에 실패하면 오류와 다시 시도", async () => {
    let calls = 0;
    reads[SNAPSHOT_PATH] = () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("요청 실패 (HTTP 503)"))
        : Promise.resolve({ text: `원본 글 ${calls}`, chars: 6, generatedAtKst: "2026-11-17 06:31 KST" });
    };
    render(<MacroPage />);

    fireEvent.click(screen.getByRole("button", { name: "원본 데이터 보기" }));
    const dialog = await screen.findByRole("dialog", { name: "전체 대시보드 원본 데이터" });
    expect(await within(dialog).findByText("요청 실패 (HTTP 503)")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "다시 시도" }));
    expect(await within(dialog).findByText("원본 글 2")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "다시 읽기" }));
    expect(await within(dialog).findByText("원본 글 3")).toBeTruthy();
    expect(snapshotCalls()).toBe(3);
  });
});

// QA-623: 원본 글을 받은 뒤 '다시 읽기'가 실패하면 useApi는 앞 글을 남기고 실패를 refreshError로만 알리는데, 원본 데이터 화면은 error만 그려
// 실패가 아무 표시 없이 묻혔습니다(개편 전 카드부터 — 단추가 '다시 읽는 중…'에서 '다시 읽기'로 돌아올 뿐). 다른 패널의 '새로 읽지 못함'(QA-067)과 같은 표시가 필요합니다.
describe("QA-623 원본 데이터 '다시 읽기' 실패를 알린다", () => {
  it.fails("받은 글이 있는 동안 다시 읽기에 실패하면 '새로 읽지 못함'과 함께 앞 글을 그대로 보인다", async () => {
    let calls = 0;
    reads[SNAPSHOT_PATH] = () => {
      calls += 1;
      return calls === 1
        ? Promise.resolve({ text: "원본 글", chars: 4, generatedAtKst: "2026-11-17 06:31 KST" })
        : Promise.reject(new Error("요청 실패 (HTTP 503)"));
    };
    render(<MacroPage />);

    fireEvent.click(screen.getByRole("button", { name: "원본 데이터 보기" }));
    const dialog = await screen.findByRole("dialog", { name: "전체 대시보드 원본 데이터" });
    await within(dialog).findByText("원본 글");

    fireEvent.click(within(dialog).getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(snapshotCalls()).toBe(2));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "다시 읽기" }).hasAttribute("disabled")).toBe(false));

    expect(within(dialog).queryByText("새로 읽지 못함")).not.toBeNull();
    expect(within(dialog).getByText("원본 글")).toBeTruthy();
  });
});
