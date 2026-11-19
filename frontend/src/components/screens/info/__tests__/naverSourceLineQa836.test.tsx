/**
 * QA-836(D1 naver-card-source-line-break, S4): 네이버 매매동향 패널 머리의 출처 줄에서 '출처 ·'가 홀로 한 줄에 남았습니다 — 출처 줄(공용 SourceLine의 p) 안에
 * 출처 글과 링크 셋을 블록 flex 상자(span.flex)로 넣어, 그 상자가 '출처 ·' 다음 줄로 내려갔습니다. 출처 글과 링크는 한 글 흐름이어야 합니다.
 * 재현 커밋에서는 it.fails였습니다. 응답은 합성 값입니다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { NaverFlowsSection } from "../NaverFlowsSection";

afterEach(() => cleanup());

const FLOWS = {
  available: true, collectedAtKst: "2026-11-18 16:50 KST", ageSeconds: 60, source: "네이버 증권", fetchTier: "impersonate", unit: "억원", failed: [],
  sourceUrls: { trader: "https://stock.naver.com/t", foreigner: "https://stock.naver.com/f", organization: "https://stock.naver.com/o" },
  trend: { KOSPI: { rows: [] } }, rankings: {},
};

const tokens = (element: Element) => String(element.getAttribute("class") ?? "").split(/\s+/);

describe("QA-836 네이버 출처 줄 — '출처 ·'와 출처 글·링크가 한 흐름", () => {
  it("출처 줄 안에 블록 flex 상자가 없고, 출처 글과 링크 셋이 같은 줄 요소에 있다", async () => {
    api.apiGetShared.mockResolvedValue(FLOWS);
    render(<NaverFlowsSection />);
    const link = await screen.findByRole("link", { name: "매매동향" });
    const line = link.closest("p") as HTMLElement;
    expect(line.textContent?.startsWith("출처")).toBe(true);
    const blocks = [...line.querySelectorAll("*")].filter((element) => tokens(element).includes("flex"));
    expect(blocks.map((element) => element.tagName)).toEqual([]);
    for (const name of ["외국인", "기관"]) expect(screen.getByRole("link", { name }).closest("p")).toBe(line);
    expect(line.textContent).toContain("네이버 증권 (비공식)");
  });
});
