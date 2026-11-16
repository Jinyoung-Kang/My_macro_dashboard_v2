/**
 * 기관 상세 보유 줄의 보조 글(클래스 · 동작 · 비중 변화 — QA-586). 응답은 모두 합성 값입니다.
 *
 * 보조 글을 ' · '로 이은 문자열 하나로 낱말 단위 줄바꿈(break-keep) 칸에 넣어, 390에서 '… · 비중' / '−0.23%p'처럼 이름표와 값이 다른 줄로
 * 갈라지고(30줄 중 14~17줄), 1366 목록에서는 동작 라벨이 '비중 확대 / (Added)'로 끊겼습니다. 종목 상세 보유 기관(QA-445)처럼 끝 조각
 * '· 비중 −0.23%p'를 끊기지 않는 한 덩어리로, 동작 라벨(백엔드 고정 어휘 — 가장 긴 것이 '비중 축소 (Reduced)')도 한 덩어리로 둡니다. 클래스
 * 조각(SEC 원문 — 길이를 모름)은 끊길 수 있게 둡니다. jsdom은 배치를 재지 못하므로 구조(클래스·요소의 자리)를 대조하고, 실제 줄은 브라우저로 봅니다.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { Holding, SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} /> }));

import { InstitutionDetailScreen } from "../InstitutionDetailScreen";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const CIK = "0009999986";

/** 요소의 클래스 낱말. */
const classes = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

/** root 안에서 text를 담은 가장 안쪽 요소 — 글이 몇 요소로 나뉘든(고치기 전후) 같은 방법으로 찾습니다. */
function deepest(root: Element, text: string): HTMLElement {
  const holders = [root, ...root.querySelectorAll("*")].filter((element) => element.textContent?.includes(text));
  const found = holders.find((element) => ![...element.children].some((child) => child.textContent?.includes(text)));
  if (!found) throw new Error(`'${text}'를 담은 요소가 없음`);
  return found as HTMLElement;
}

/** element에서 stop(포함)까지 올라가는 조상 줄. */
function chainTo(element: Element, stop: Element): Element[] {
  const chain: Element[] = [];
  for (let node: Element | null = element; node && stop.contains(node); node = node.parentElement) chain.push(node);
  return chain;
}
const inChain = (chain: Element[], word: string) => chain.some((node) => classes(node).includes(word));

const HOLDINGS: Holding[] = [
  { name: "SYNTHETIC HOLDING A", cusip: "000000586", class: "COM", value: 2e9, shares: 1000, weight: 12, weightDiff: -12.345, sharesDiff: -500, action: "비중 축소 (Reduced)" },
  { name: "SYNTHETIC HOLDING B", cusip: "000000587", class: "COM", value: 1e9, shares: 1000, weight: 6, weightDiff: null, sharesDiff: null, action: "신규 매수 (New)" },
];

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path === endpoints.institution.portfolio(CIK, 8, 30)
      ? Promise.resolve({
          available: true, cik: CIK, institution: { name: "합성 연금 (Synthetic Pension)", desc: "" },
          quarters: [{ filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 3e9, holdingCount: 2 }],
          latest: { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: 3e9 }, holdings: HOLDINGS,
        })
      : new Promise(() => {}),
  );
});
afterEach(cleanup);

describe("기관 상세 보유 줄 보조 글 — '비중'과 값·동작 라벨이 갈라지지 않음 (QA-586)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 '비중 −12.35%p'가 든 가장 안쪽 요소가 보조 글 전체(break-keep) 한 칸이라 그 사슬에 whitespace-nowrap이 없었습니다.
  it.fails("끝 조각 '· 비중 <값>%p'와 동작 라벨은 끊기지 않는 한 덩어리, 클래스 조각은 끊길 수 있음, 말줄임 없음", async () => {
    render(
      <SessionUserProvider user={MEMBER}>
        <InstitutionDetailScreen cik={CIK} />
      </SessionUserProvider>,
    );
    fireEvent.click(await screen.findByRole("tab", { name: "보유 종목" }));
    const list = await screen.findByRole("list", { name: "상위 보유 종목" });
    const row = within(list).getByRole("button", { name: /SYNTHETIC HOLDING A/ });

    const weight = deepest(row, "비중 −12.35%p");
    expect(inChain(chainTo(weight, row), "whitespace-nowrap")).toBe(true);
    // 기호(U+2212)와 '%p'가 한 요소 안 — 값 안에서도 끊기지 않음
    expect(weight.textContent).toBe("· 비중 −12.35%p");
    expect(inChain(chainTo(weight, row), "truncate")).toBe(false);

    const action = deepest(row, "비중 축소 (Reduced)");
    expect(inChain(chainTo(action, row), "whitespace-nowrap")).toBe(true);
    // 클래스 조각(SEC 원문)은 nowrap이 아님 — 보조 글 칸의 break-keep wrap-anywhere 안에서 끊길 수 있음
    const sub = weight.parentElement as HTMLElement;
    expect(sub.textContent).toBe("COM · 비중 축소 (Reduced) · 비중 −12.35%p");
    expect(classes(sub)).toEqual(expect.arrayContaining(["break-keep", "wrap-anywhere"]));
    expect(classes(sub)).not.toContain("whitespace-nowrap");

    // 비중 변화를 모르면 그 조각이 없음(글은 '클래스 · 동작')
    const other = within(list).getByRole("button", { name: /SYNTHETIC HOLDING B/ });
    expect(deepest(other, "신규 매수 (New)").parentElement?.textContent).toBe("COM · 신규 매수 (New)");
    expect(within(other).queryByText(/비중 /)).toBeNull();
  });
});
