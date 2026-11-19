/**
 * QA-850 — AI 리포트 엔진 고르기의 선택지 글이 상자에서 잘림(작업대 실행 명세 §7 7행 'AI 리포트: … 엔진 선택 글 잘림 고침', S4, 개편 전부터).
 *
 * 선택지 글이 '{엔진 이름} · {속도 안내} (못 쓰는 이유)'라 가장 긴 것(QA 스택 GET /api/ai/engines — '자동 탐색 — 권장 (Failover) · 빠름 — 빠른 엔진부터
 * 시도합니다')이 넓은 화면 22rem 상자에서 잘려 고른 엔진의 속도·이유를 끝까지 읽을 수 없었습니다.
 *
 * 기대: 선택지 글은 엔진 이름 + 못 쓰는 이유 꼬리('(키 없음)'·'(이 배포에서 사용 안 함)')만, 고른 엔진의 속도·모델·쓸 수 있는지는 고르기 아래 속성 목록에.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import AiReportPage from "../ai/report/page";

const ENGINES = {
  enabled: true,
  engines: [
    { id: "auto", label: "자동 탐색 — 권장 (Failover)", provider: "auto", model: null, description: "빠른 엔진부터 부릅니다",
      speedHint: "빠름 — 빠른 엔진부터 시도합니다", available: true, unavailableReason: null },
    { id: "nvidia_nemotron", label: "NVIDIA — Nemotron-3 Super 120B", provider: "nvidia", model: "nvidia/nemotron-3-super-120b", description: "추론형",
      speedHint: "느림 — 추론형이라 1~2분", available: false, unavailableReason: "no_key" },
  ],
};

beforeEach(() => {
  const reads: Record<string, unknown> = {
    "/api/ai/engines": ENGINES,
    "/api/ai/report-types": { types: ["종합 매크로 브리핑"] },
  };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

describe("QA-850 AI 리포트 엔진 고르기 — 선택지 글은 이름과 이유만, 속도·모델은 아래 속성", () => {
  it.fails("선택지에 속도 안내가 없고, 고른 엔진의 속도·모델·쓸 수 있는지가 고르기 아래 속성 목록에", async () => {
    render(<AiReportPage />);
    const select = (await screen.findByLabelText("AI 엔진")) as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(2));
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "자동 탐색 — 권장 (Failover)",
      "NVIDIA — Nemotron-3 Super 120B (키 없음)",
    ]);
    const engine = screen.getByRole("region", { name: "고른 엔진" });
    const value = (label: string) => within(engine).getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
    expect(value("속도")).toBe("빠름 — 빠른 엔진부터 시도합니다");
    expect(value("모델")).toBe("—값 없음");
    expect(value("쓸 수 있는지")).toBe("쓸 수 있음");

    fireEvent.change(select, { target: { value: "nvidia_nemotron" } });
    expect(value("속도")).toBe("느림 — 추론형이라 1~2분");
    expect(value("모델")).toBe("nvidia/nemotron-3-super-120b");
    expect(value("쓸 수 있는지")).toBe("키 없음");
  });
});
