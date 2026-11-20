/**
 * AI 리포트의 긴 글 문법(작업대 P7 — 실행 명세 §7 7행 'AI 리포트: 긴 글 문법').
 *
 * - 문단·목록은 긴 글 단계(15/24 — text-running)·한 줄 72자 폭·낱말 사이 줄바꿈, 절 제목은 heading-sm. 표는 공용 표(최소 640px — QA-869), 글 칸은 낱말 사이 줄바꿈
 *   (첫 열은 행 머리 th).
 * - 목차는 공용 긴 화면 목차(SectionIndex — xl부터 세로 목록). 뒤로·앞으로 가기(hashchange)로 해시가 절이 되면 그 절로 옮깁니다(D3b 넘김 — 예전 버튼 줄은
 *   기록만 쌓고 기록 이동에는 본문이 움직이지 않았음). 절이 둘 이하면 목차 없음.
 * - 원문(Markdown) 보기와 AI 입력 원본은 공용 로그 상자(LogPanel — 이름 있는 영역), 생성 실패는 위험 안내 상자(제목 '생성 실패').
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import AiReportPage from "../ai/report/page";
import { ReportView } from "../ai/report/ReportView";

const REPORT = `## 1. 핵심 요약
합성 요약 문단입니다.

## 2. 수급
- 합성 수급 한 줄

| 항목 | 값 |
|---|---|
| 외국인 순매수 | 1,339.98 |

## 3. 데이터 신뢰도
- 합성 신뢰도 한 줄
`;

const READS: Record<string, unknown> = {
  "/api/ai/engines": {
    enabled: true,
    engines: [{ id: "auto", label: "자동", provider: "auto", model: null, description: "", available: true, unavailableReason: null }],
  },
  "/api/ai/report-types": { types: ["종합 매크로 브리핑"] },
  "/api/snapshot/text": { text: "원본 한 줄\n원본 두 줄", generatedAtKst: "2026-11-18 09:00 KST", chars: 10 },
};

beforeEach(() => {
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in READS ? Promise.resolve(READS[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

describe("AI 리포트 본문 — 긴 글 문법", () => {
  it("문단·목록은 15/24 글·72자 폭·낱말 사이 줄바꿈, 절 제목은 heading-sm, 표 글 칸은 낱말 사이 줄바꿈", () => {
    render(<ReportView markdown={REPORT} />);
    const paragraph = screen.getByText("합성 요약 문단입니다.").closest("p") as HTMLElement;
    expect(paragraph.className).toContain("max-w-[72ch]");
    expect(paragraph.className).toContain("break-keep");
    expect(paragraph.closest(".text-running")).not.toBeNull();
    const list = screen.getByText("합성 수급 한 줄").closest("ul") as HTMLElement;
    expect(list.className).toContain("max-w-[72ch]");
    expect(screen.getByRole("heading", { name: "2. 수급", level: 3 }).className).toContain("text-heading-sm");
    const cell = within(screen.getByRole("table")).getByText("외국인 순매수").closest("th") as HTMLElement;
    expect(cell.className).toContain("break-keep");
    expect(screen.getByRole("table").className).toContain("min-w-[640px]");
  });

  it("목차는 공용 긴 화면 목차(xl부터 세로 목록) — 절이 둘 이하면 목차 없음", () => {
    const { unmount } = render(<ReportView markdown={REPORT} />);
    const toc = screen.getByRole("navigation", { name: "리포트 목차" });
    expect(toc.getAttribute("data-section-index-bar")).toBe("xl");
    unmount();
    render(<ReportView markdown={"## 1. 핵심 요약\n합성\n\n## 2. 수급\n합성"} />);
    expect(screen.queryByRole("navigation", { name: "리포트 목차" })).toBeNull();
  });

  it("뒤로·앞으로 가기(hashchange)로 해시가 절이 되면 그 절로 옮긴다(D3b 넘김)", () => {
    const into = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    const base = window.location.pathname + window.location.search;
    try {
      render(<ReportView markdown={REPORT} />);
      const href = (screen.getByRole("navigation", { name: "리포트 목차" }).querySelectorAll("a")[2].getAttribute("href") as string);
      window.history.replaceState(null, "", href);
      act(() => {
        window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: `http://localhost${base}`, newURL: `http://localhost${base}${href}` }));
      });
      const section = document.getElementById(href.slice(1)) as HTMLElement;
      expect(section.tagName).toBe("SECTION");
      expect(into.mock.contexts).toEqual([section]);
    } finally {
      window.history.replaceState(null, "", base);
      into.mockRestore();
    }
  });
});

describe("AI 리포트 화면 — 원문·원본·실패", () => {
  async function generated(reply: unknown) {
    api.apiPost.mockResolvedValue(reply);
    render(<AiReportPage />);
    const button = (await screen.findByRole("button", { name: "리포트 생성" })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
  }

  it("원문(Markdown) 보기는 공용 로그 상자 '리포트 원문 (스크롤)'", async () => {
    await generated({ status: true, response: REPORT, reportType: "종합 매크로 브리핑", provider: "합성", latencyMs: 10 });
    fireEvent.click(await screen.findByRole("button", { name: "원문(Markdown) 보기" }));
    const raw = screen.getByRole("region", { name: "리포트 원문 (스크롤)" });
    expect(raw.tagName).toBe("PRE");
    expect(raw.textContent).toBe(REPORT);
  });

  it("AI 입력 원본은 공용 로그 상자(옅은 글 'AI 입력 원본 (스크롤)')", async () => {
    render(<AiReportPage />);
    fireEvent.click(screen.getByRole("button", { name: "AI에 전달되는 원본 데이터 보기" }));
    const raw = await screen.findByRole("region", { name: "AI 입력 원본 (스크롤)" });
    expect(raw.textContent).toBe("원본 한 줄\n원본 두 줄");
    expect(raw.className).toContain("text-text-3");
  });

  it("생성 실패(응답의 실패)는 위험 안내 상자 — 제목 '생성 실패' + 서버 글", async () => {
    await generated({ status: false, error: "합성 실패 사유", failoverPath: ["합성 경로 하나"] });
    const message = await screen.findByText("합성 실패 사유");
    const box = message.closest(".text-danger")?.parentElement as HTMLElement;
    expect(within(box).getByText("생성 실패")).toBeTruthy();
    expect(within(box).getByText("주의:")).toBeTruthy();
    expect(within(box).getByText("합성 경로 하나")).toBeTruthy();
  });
});
