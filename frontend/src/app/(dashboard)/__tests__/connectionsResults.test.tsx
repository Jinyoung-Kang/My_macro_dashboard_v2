/**
 * 연결 테스트(/connections) 표와 결과 안내 상자(작업대 P7 — 실행 명세 §7 7행 '연결 테스트: 표와 결과 안내 상자').
 *
 * - 등록된 엔진: 공용 조밀 표(개수 줄), 모델은 고정폭, 키는 상태 아이콘 + 글(설정됨 정상·사용 안 함·없음 중립 — 예전 정상색 글만).
 * - 호출 응답: 성공은 정상 안내 상자(제목 '응답 — 제공자 · 지연 · 단계', 응답 글 15/24), 실패는 위험 안내 상자(제목 '호출 실패').
 * - 토스: 진단 결과는 안내 상자(성공 정상·실패 주의) + 단계 태그, 조회 JSON은 공용 로그 상자, 참고는 중립 안내 상자.
 * 응답은 모두 모의 — 실제 AI·토스 호출 없음.
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

import { AiEngineSection } from "../connections/AiEngineSection";
import { TossSection } from "../connections/TossSection";

const ENGINES = {
  enabled: true,
  keys: {},
  engines: [
    { id: "auto", label: "자동 탐색", provider: "auto", model: null, description: "빠른 엔진부터", available: true, unavailableReason: null },
    { id: "nvidia_nemotron", label: "NVIDIA — Nemotron", provider: "nvidia", model: "nvidia/nemotron", description: "추론형", available: false, unavailableReason: "not_allowed" },
    { id: "cerebras_llama", label: "Cerebras — Llama", provider: "cerebras", model: "llama-3.3-70b", description: "", available: false, unavailableReason: "no_key" },
  ],
};

let diagnostics: unknown = null;
beforeEach(() => {
  diagnostics = null;
  for (const fn of [api.apiGet, api.apiPost, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path === "/api/ai/engines") return Promise.resolve(ENGINES);
    if (path.startsWith("/api/ai/toss/diagnostics") && diagnostics) return Promise.resolve(diagnostics);
    return new Promise(() => {});
  });
});
afterEach(() => cleanup());

async function callButton(): Promise<HTMLButtonElement> {
  const button = (await screen.findByRole("button", { name: "선택 모델 호출" })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}

describe("연결 테스트 — AI 엔진", () => {
  it("등록된 엔진은 조밀 표·개수 줄, 모델은 고정폭, 키는 상태 아이콘 + 글", async () => {
    render(<AiEngineSection />);
    const table = await screen.findByRole("region", { name: "등록된 엔진 (좌우 스크롤)" });
    expect(within(table.closest("section") as HTMLElement).getByText("3건")).toBeTruthy();
    expect(within(table).getByText("nvidia/nemotron").className).toContain("font-mono");
    for (const [label, tone] of [["설정됨", "text-ok"], ["이 배포에서 사용 안 함", "text-text-3"], ["없음", "text-text-3"]] as const) {
      const status = within(table).getByText(label).closest(`.${tone}`) as HTMLElement;
      expect(status, label).not.toBeNull();
      expect(status.querySelector("svg")?.getAttribute("aria-hidden"), label).toBe("true");
    }
  });

  it("호출 성공은 정상 안내 상자(제목에 제공자·지연·단계), 실패는 위험 안내 상자 '호출 실패'", async () => {
    api.apiPost.mockResolvedValueOnce({ status: true, response: "정상입니다", provider: "cerebras", latencyMs: 120, pipelineStep: "직접" });
    render(<AiEngineSection />);
    fireEvent.click(await callButton());
    const reply = await screen.findByText("정상입니다");
    expect(reply.className).toContain("text-running");
    const okBox = reply.closest(".text-ok") as HTMLElement;
    expect(within(okBox).getByText("응답 — cerebras · 120ms · 직접")).toBeTruthy();
    cleanup();

    api.apiPost.mockResolvedValueOnce({ status: false, error: "합성 실패", pipelineStep: "직접" });
    render(<AiEngineSection />);
    fireEvent.click(await callButton());
    const failed = await screen.findByText("합성 실패");
    const dangerBox = failed.closest(".text-danger") as HTMLElement;
    expect(within(dangerBox).getByText("호출 실패")).toBeTruthy();
  });
});

describe("연결 테스트 — 토스", () => {
  it("진단 결과는 안내 상자 + 단계 태그(실패는 주의), 조회 JSON은 로그 상자, 참고는 중립 안내 상자", async () => {
    diagnostics = { ok: false, stage: "auth", message: "토큰 발급 실패" };
    api.apiGet.mockResolvedValue({ ok: true, rate: 1385.2 });
    render(<TossSection />);
    fireEvent.click(screen.getByRole("button", { name: "진단 실행" }));
    const title = await screen.findByText("연결 실패");
    const box = title.closest(".text-warn") as HTMLElement;
    expect(within(box).getByText("auth").closest("span")?.className).toContain("rounded-control");
    expect(within(box).getByText("토큰 발급 실패")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "환율 조회 (USD → KRW)" }));
    const json = await screen.findByRole("region", { name: "토스 조회 결과 (스크롤)" });
    expect(json.textContent).toContain('"rate": 1385.2');
    expect(json.className).toContain("text-text-3");
    expect(screen.getByText("참고").closest(".bg-surface-2")).not.toBeNull();
  });
});
