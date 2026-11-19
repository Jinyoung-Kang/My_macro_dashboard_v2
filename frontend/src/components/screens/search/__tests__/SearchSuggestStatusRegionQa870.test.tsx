/**
 * 정보 검색 입력 후보 안내의 알림 영역 — QA-870(작업대 P7 검토에서 찾음, QA-860 고침의 뒤).
 *
 * QA-860 고침은 '후보 0건'·'후보를 받지 못함' 안내를 조건이 참이 될 때 <p role="status">째 새로 붙였습니다(읽는 동안에는 떼어 냄). 이미 있던 알림 영역의
 * 내용이 바뀌는 것이 아니라 새로 붙는 영역의 첫 글이라, 낭독기(NVDA·JAWS + 크롬 등)가 대체로 읽어 주지 않습니다 — 같은 화면의 기간 막대(PeriodBars)와
 * 공용 거르기 목록은 영역을 늘 두고 글만 바꿉니다.
 *
 * 기대: 입력칸 아래 알림 영역(role=status)이 처음부터 있고(글 없음 — 눈에 보이지 않아 자리를 차지하지 않음), 0건 응답이 오면 같은 영역에 글이 들어갑니다.
 * 보이는 글·자리·요청은 QA-860 그대로입니다.
 * 수정 전(재현 커밋에서는 it.fails): 'expected null not to be null'(묻기 전에는 role=status 영역이 없음).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { endpoints } from "@/lib/endpoints";
import { SearchBox } from "../SearchBox";

beforeEach(() => {
  vi.useFakeTimers();
  api.apiGet.mockReset();
  api.apiGet.mockImplementation((path: string) =>
    path === endpoints.search.suggest("없는말") ? Promise.resolve({ available: true, items: [] }) : new Promise(() => {}),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("입력 후보 안내의 알림 영역(QA-870)", () => {
  it.fails("알림 영역은 처음부터 있고(글 없음), 0건 응답이 오면 같은 영역에 글이 들어간다", async () => {
    const { container } = render(<SearchBox initial={null} onSubmit={() => {}} onChoose={() => {}} />);
    const form = container.querySelector("form") as HTMLFormElement;
    const before = form.querySelector('[role="status"]');
    expect(before).not.toBeNull();
    expect(before?.textContent).toBe("");
    const input = screen.getByRole("combobox", { name: "대상 검색" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "없는말" } });
    expect(form.querySelector('[role="status"]')).toBe(before);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    const status = screen.getByText(/후보가 없습니다/);
    expect(status).toBe(before);
    expect(status.textContent).toContain("Enter로 찾을 수는 있습니다");
  });
});
