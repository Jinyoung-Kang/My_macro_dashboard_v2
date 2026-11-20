/**
 * 저장소 상태 스냅샷 신선도 '수집' 칸의 줄바꿈 — QA-878(작업대 P7 검토에서 찾음, 브라우저 측정).
 *
 * QA-846이 오래된 줄의 '수집' 칸에 주의 태그 '오래됨'을 더하면서 칸 안을 꺾이는 flex(`flex-wrap`)로 두어, 390에서 '수집' 칸(106px) 안의 나이 '15일 전' 아래로
 * 태그가 줄을 바꿨습니다 — 스냅샷 101행이 33 → 69px로 거의 두 배가 되어 문서가 9,350 → 14,176px로 길어졌습니다(1024는 같은 칸 150px에서 한 줄).
 * 표는 이미 최소 640px로 가로 스크롤하므로 이 칸이 꺾일 까닭이 없습니다. jsdom은 배치를 재지 않아 칸 클래스로 봅니다.
 *
 * 기대: '수집' 칸은 줄을 바꾸지 않음 — 칸은 오른쪽 정렬 열이라 이미 whitespace-nowrap이지만 칸 안 묶음(inline-flex)이 flex-wrap이라 태그가 다음 줄로 갔으므로,
 * 칸 안 묶음에 flex-wrap이 없어야 나이와 태그가 한 줄.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): "expected [ 'inline-flex', 'flex-wrap', …(4) ] to not include 'flex-wrap'".
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { endpoints } from "@/lib/endpoints";
import StatusPage from "../status/page";

const SNAPSHOTS = [
  { name: "krx_futures", status: "estimated", error: null, ageSeconds: 1_296_000, stale: true, collectedAt: "2026-11-03T00:00:00Z" },
];

beforeEach(() => {
  const reads: Record<string, unknown> = {
    [endpoints.status.overview]: { readMode: "auto", collectorReachable: true, taskSummary: [], snapshots: SNAPSHOTS },
  };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

describe("스냅샷 신선도 '수집' 칸은 한 줄(QA-878)", () => {
  it("나이와 '오래됨' 태그가 줄을 바꾸지 않는다 — 칸 whitespace-nowrap, 칸 안 묶음에 flex-wrap 없음", async () => {
    render(<StatusPage />);
    const table = await screen.findByRole("region", { name: "스냅샷 신선도 (좌우 스크롤)" });
    const age = (within(table).getByText("krx_futures").closest("tr") as HTMLTableRowElement).cells[2];
    expect(within(age).getByText("오래됨")).toBeTruthy();
    expect(tokens(age)).toContain("whitespace-nowrap");
    for (const element of age.querySelectorAll("*")) expect(tokens(element)).not.toContain("flex-wrap");
  });
});
