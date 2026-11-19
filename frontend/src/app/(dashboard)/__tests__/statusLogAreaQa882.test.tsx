/**
 * 저장소 상태 로그 절 — 응답 뒤에도 첫 적재 자리표시와 같은 높이(QA-882, 작업대 P7 합친 뒤 검토에서 찾음, 브라우저 CLS 측정).
 *
 * QA-876 고침(3afc8ee3)은 첫 읽기 동안 로그 상자 높이 한도(30rem = 480px)의 자리 막대를 둡니다. 응답의 로그가 그보다 짧거나 오류·경고가 없으면(상자 대신
 * 한 줄) 응답 뒤 이 절이 줄어 아래 태스크·스냅샷 패널이 화면 안으로 당겨 올라왔습니다. 오류·경고 0(text '')을 합성한 첫 적재 CLS — 390 0·1024 0.1024·
 * 1440 0.0919·1920 0.052(기준 0d016ca1 0·0·0·0.0061), 높은 창(1440×1200)에서는 0.1369, 몇 줄짜리 로그(14줄)도 1440×1200 0.0252.
 *
 * 기대: 응답 뒤의 로그 자리는 자리표시와 같은 높이 — 글이 있으면 로그 상자를 높이 한도 그대로(짧아도 줄지 않음), 오류·경고가 없거나 수집기에 닿지 못한 안내
 * 한 줄은 그 높이만큼 자리를 둠. 화면 순서·글·요청은 그대로입니다.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 첫 사례 "expected [ 'text-sm' ] to include 'min-h-[30rem]'", 둘째 사례
 * "expected [ 'max-h-[30rem]', …(16) ] to include 'h-[30rem]'", 셋째 사례 "expected [ 'text-sm', 'text-text-3' ] to include 'min-h-[30rem]'".
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

import type { StatusIssuesResponse } from "@/lib/types";
import { IssuesPanel } from "../status/IssuesPanel";

/** 합성 응답 — 실제 실행 기록이 아님. */
function issues(over: Partial<StatusIssuesResponse>): StatusIssuesResponse {
  return {
    generatedAt: "2026-11-19 19:40 KST", collectorReachable: true, lookbackHours: 24, lastRunStatus: "ok",
    counts: { errors: 0, warnings: 0, recentGroups: 0, missingDatasets: 0 },
    current: [], recent: [], missing: [], text: "",
    ...over,
  };
}

const SHORT_LOG = "[Local Macro Dashboard] 수집 오류·경고 로그\n요약: 현재 오류 0 · 현재 경고 1\n\n■ 지금 실패 중인 태스크 (최근 결과 기준)\n  [경고] synthetic_task · 2026-11-19 19:30";

let response: StatusIssuesResponse | null = null;

beforeEach(() => {
  response = null;
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation(() => (response ? Promise.resolve(response) : new Promise(() => {})));
});
afterEach(() => cleanup());

const tokens = (element: Element | null) => (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

/** 첫 읽기 동안의 로그 자리 막대 높이(px). */
function pendingHeight(): number {
  const log = screen.getByRole("status", { name: "실행 기록을 모으는 중" });
  return Number.parseFloat((log.querySelector("[style]") as HTMLElement | null)?.style.height ?? "0");
}

describe("저장소 상태 로그 절 — 응답 뒤에도 자리표시와 같은 높이(QA-882)", () => {
  it.fails("오류·경고 없음(text '') — 안내 한 줄이 로그 상자 높이(30rem)만큼 자리를 둠", async () => {
    const { unmount } = render(<IssuesPanel />);
    await act(async () => {});
    // 자리 막대는 로그 상자 높이 한도와 같은 480px(30rem).
    expect(pendingHeight()).toBe(480);
    unmount();
    response = issues({});
    render(<IssuesPanel />);
    const line = (await screen.findByText(/최근 24시간 동안 오류·경고가 없습니다/)).closest("p");
    expect(tokens(line)).toContain("min-h-[30rem]");
  });

  it.fails("짧은 로그 — 로그 상자가 글 길이로 줄지 않고 높이 한도(30rem) 그대로", async () => {
    response = issues({ counts: { errors: 0, warnings: 1, recentGroups: 0, missingDatasets: 0 }, text: SHORT_LOG });
    render(<IssuesPanel />);
    const box = await screen.findByRole("region", { name: "수집 오류·경고 로그 (스크롤)" });
    expect(box.textContent).toBe(SHORT_LOG);
    expect(tokens(box)).toContain("h-[30rem]");
    expect(tokens(box)).not.toContain("max-h-[30rem]");
  });

  it.fails("수집기에 닿지 못해 누락 데이터셋을 모름 — 안내 한 줄도 같은 자리", async () => {
    response = issues({ collectorReachable: false, counts: { errors: 0, warnings: 0, recentGroups: 0, missingDatasets: null } });
    render(<IssuesPanel />);
    const line = (await screen.findByText(/수집기에 연결하지 못해 누락 데이터셋은/)).closest("p");
    expect(tokens(line)).toContain("min-h-[30rem]");
  });
});
