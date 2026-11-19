/**
 * QA-847 — 저장소 상태 '최근 수집 상태'가 원시 코드 'empty'를 영어 그대로 보임(D1 QA `status-run-raw-empty-code`, S4, 개편 전부터).
 *
 * 수집기는 실패가 전부 '수집 결과 없음'(소스가 새 데이터를 주지 않아 저장본 유지)인 실행을 'empty'로 적습니다(collector runner._run_status — 태스크
 * 화면은 같은 것을 '데이터 없음'이라 부름). 화면의 상태 글 표(RUN_STATUS_LABEL)에 그 값이 없어 표에 없는 코드를 그대로 찍었습니다.
 *
 * 기대: 'empty'는 같은 화면 태스크 표 범례와 같은 글 '데이터 없음(기존 저장본 유지)', 영어 코드 'empty'는 보이지 않음.
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

beforeEach(() => {
  const reads: Record<string, unknown> = {
    [endpoints.status.overview]: { readMode: "auto", collectorReachable: true, lastRunStatus: "empty", taskSummary: [] },
  };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

describe("QA-847 최근 수집 상태 — 'empty'를 한국어 글로", () => {
  it.fails("'empty'는 '데이터 없음(기존 저장본 유지)', 영어 코드는 보이지 않는다", async () => {
    render(<StatusPage />);
    const tile = await screen.findByRole("group", { name: "최근 수집 상태" });
    expect(within(tile).queryByText("empty")).toBeNull();
    expect(within(tile).getByText("데이터 없음(기존 저장본 유지)")).toBeTruthy();
  });
});
