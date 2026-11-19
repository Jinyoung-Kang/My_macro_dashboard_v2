/**
 * 저장소 상태 로그 절 — 첫 읽기 자리표시의 바깥 높이가 응답 뒤 로그 자리(30rem)와 같음(QA-885, 작업대 P7 합친 뒤 고침의 반박 확인에서 찾음).
 *
 * QA-882 고침(784cc4d7)은 응답 뒤 로그 자리를 늘 30rem(480px)으로 두고, 첫 읽기의 자리 막대도 480px로 두었습니다. 그런데 공용 Skeleton은 막대를 위아래
 * 여백(py-1 — 8px)이 있는 상자에 넣어, 자리표시의 바깥 높이는 488px이었습니다. 그래서 응답 뒤 이 절이 모든 경우 8px 줄어 아래 태스크·스냅샷 패널을 당겼습니다
 * (자기 빌드 1440×1200, issues 4초 지연: 읽는 중 자리표시 488px · #status-tasks y 1084 → 짧은 로그·긴 로그 1076).
 *
 * 기대: 자리표시의 바깥 높이(막대 + 상자 위아래 여백)가 응답 뒤 로그 자리와 같은 480px. 화면 순서·글·요청은 그대로입니다.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 'expected 488 to be 480'.
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

import { IssuesPanel } from "../status/IssuesPanel";

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => cleanup());

/** Tailwind 세로 여백 클래스(p-N·py-N·pt-N·pb-N — 한 칸 4px)의 위아래 합(px). */
function verticalPadding(element: Element): number {
  let total = 0;
  for (const token of (element.getAttribute("class") ?? "").split(/\s+/)) {
    const match = /^p([ytb]?)-(\d+(?:\.\d+)?)$/.exec(token);
    if (match === null) continue;
    const step = Number.parseFloat(match[2]) * 4;
    total += match[1] === "t" || match[1] === "b" ? step : step * 2;
  }
  return total;
}

describe("저장소 상태 로그 절 — 첫 읽기 자리표시의 바깥 높이(QA-885)", () => {
  it.fails("자리표시(막대 + 상자 위아래 여백)가 응답 뒤 로그 자리와 같은 480px(30rem)", async () => {
    render(<IssuesPanel />);
    await act(async () => {});
    const status = screen.getByRole("status", { name: "실행 기록을 모으는 중" });
    const bar = status.querySelector<HTMLElement>("[style]");
    const barHeight = Number.parseFloat(bar?.style.height ?? "0");
    // 막대 말고 자리를 차지하는 자식은 없습니다(읽어 주는 글은 sr-only — 절대 위치라 세로 자리 없음).
    expect([...status.children].filter((child) => child !== bar && !child.classList.contains("sr-only"))).toEqual([]);
    expect(barHeight + verticalPadding(status)).toBe(480);
  });
});
