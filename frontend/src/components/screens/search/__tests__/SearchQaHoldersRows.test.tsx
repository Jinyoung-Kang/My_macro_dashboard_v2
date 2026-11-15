/**
 * 정보 검색 보유 탭 — 13F 보유 줄의 공시 이름·보고일 줄(QA-445, ADR 0041 결정 11). 응답은 모두 합성 값입니다(실제 기관·법인의 자료를 쓰지 않음).
 *
 * QA-436 뒤로 이름 검색에 잘린 공시 이름과 펀드 묶음 이름이 일부러 함께 걸려, 줄마다 공시 이름으로 다른 회사가 섞였는지 가려야 하고 보고일은 2년 규칙의
 * 근거입니다. 그런데 이 줄은 '공시 이름 · 보고일'을 한 줄 말줄임(block truncate)으로 묶고 title도 없어, 좁은 칸에서는 줄 끝의 보고일이 먼저 잘리고
 * 전체 글을 볼 길이 없었습니다(390에서 세 줄 모두). jsdom은 배치를 재지 못하므로 고침이 세우는 구조(클래스·요소의 자리)를 대조하고, 실제 폭은 QA 스택
 * 브라우저(390·1440)로 확인합니다.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { endpoints } from "@/lib/endpoints";
import { kstToday, rangeStart } from "@/lib/infoSearch";
import type { GuruHoldersResponse, SearchEntity } from "@/lib/types";
import { HoldingsPanel } from "../HoldingsPanel";

/** 요소의 클래스 낱말(접두가 붙은 것은 따로 — 'truncate'와 'lg:truncate'는 다른 낱말). */
const classes = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

/** root 안에서 text를 담은 가장 안쪽 요소 — 글이 몇 요소로 나뉘든(고치기 전후) 같은 방법으로 찾습니다. */
function deepest(root: Element, text: string): HTMLElement {
  const holders = [root, ...root.querySelectorAll("*")].filter((element) => element.textContent?.includes(text));
  const found = holders.find((element) => ![...element.children].some((child) => child.textContent?.includes(text)));
  if (!found) throw new Error(`'${text}'를 담은 요소가 없음`);
  return found as HTMLElement;
}

/** element에서 stop(포함)까지 올라가는 조상 줄 — overflow·white-space·overflow-wrap은 상속되거나 조상 상자에서 걸리므로 줄 전체를 봅니다. */
function chainTo(element: Element, stop: Element): Element[] {
  const chain: Element[] = [];
  for (let node: Element | null = element; node && stop.contains(node); node = node.parentElement) chain.push(node);
  return chain;
}
const inChain = (chain: Element[], word: string) => chain.some((node) => classes(node).includes(word));

const QUERY = "SYNTHETIC EXAMPLE FINANCIAL";

const COMPANY: SearchEntity = {
  key: "us:SYNF", kind: "company", name: "합성금융", nameKo: "합성금융", nameEn: "Synthetic Example Financial", aliases: [], description: null,
  ids: { ticker: "SYNF", market: "us", stockCode: null, cik: null, dartCorpCode: null, wikidata: null },
  links: [], sources: [],
};

/** 공시 이름 셋 — 잘린 이름 둘(QA-436이 함께 찾는 모양)과 칸보다 훨씬 긴 이름 하나. */
const NAMES = [
  "SYNTHETIC EXAMPLE FINANCI ADR",
  "SYNTHETIC EXAMPLE FINANCIAL",
  "SYNTHETIC EXAMPLE FINANCIAL HOLDINGS GROUP INC SPONSORED ADR",
] as const;
const INSTITUTIONS = ["합성 자산운용", "가상 투자자문 (Example Advisors)", "예시 연기금"] as const;

function holders(reportDate: string): GuruHoldersResponse {
  return {
    available: true, query: QUERY, totalMatches: 3, truncated: false,
    rows: NAMES.map((name, index) => ({
      institution: INSTITUTIONS[index], cik: `000000000${index + 1}`, name, cusip: `00000010${index}`, weight: 3 - index, value: 1_000_000, reportDate,
    })),
  };
}

let reportDate = "";

beforeEach(() => {
  // 최근 2년 안의 보고일(오늘 KST에서 30일 전) — 2년 규칙(계약 §5)에 걸리지 않게.
  reportDate = rangeStart("30d", kstToday(Date.now()));
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path === endpoints.institution.guruHolders(QUERY) ? Promise.resolve(holders(reportDate)) : new Promise(() => {}),
  );
});
afterEach(cleanup);

describe("보유 탭 — 13F 보유 줄의 공시 이름·보고일(QA-445)", () => {
  // QA-445: '{공시 이름} · 보고일 {날짜}'를 한 줄 말줄임(block truncate)으로 묶어, 좁은 칸에서 긴 공시 이름이면 보고일이 먼저 잘리고 title도 없어 전체를
  // 볼 수 없었습니다. 수정 전 실패: 보고일·공시 이름을 담은 요소의 조상(줄까지)에 truncate가 있음(재현 커밋에서는 it.fails).
  it.fails("공시 이름은 제 칸 안에서 줄바꿈(말줄임 없음)하고 보고일은 끊기지 않는 한 덩어리로 늘 보인다 — 숫자 칸은 따로, lg 미만 44px 그대로", async () => {
    render(<HoldingsPanel entity={COMPANY} loading={false} />);
    await screen.findByRole("heading", { name: /13F 보유 기관/ });

    for (const [index, name] of NAMES.entries()) {
      const link = screen.getByRole("link", { name: INSTITUTIONS[index] });
      const row = link.closest("li")!;
      const cell = link.parentElement!;

      // 결함을 직접 보는 단언 먼저(수정 전에는 여기서 실패) — 보고일과 공시 이름 어디에도 말줄임이 걸리지 않음.
      const date = deepest(row, `보고일 ${reportDate}`);
      const nameLine = deepest(row, name);
      expect(inChain(chainTo(date, row), "truncate")).toBe(false);
      expect(inChain(chainTo(nameLine, row), "truncate")).toBe(false);

      // 수정이 정한 구조 — 공시 이름은 칸보다 긴 낱말도 칸 안에서 끊고(wrap-anywhere), 보고일('· 보고일 YYYY-MM-DD')은 줄바꿈하지 않는 한 덩어리.
      expect(inChain(chainTo(nameLine, row), "wrap-anywhere")).toBe(true);
      expect(inChain(chainTo(date, row), "whitespace-nowrap")).toBe(true);
      expect(date.textContent).toBe(`· 보고일 ${reportDate}`);
      expect(cell.contains(date) && cell.contains(nameLine)).toBe(true);

      // 숫자는 이름 칸 밖의 제 칸(두 칸 격자, 이름 칸은 줄어드는 칸), lg 미만 44px.
      expect(classes(row)).toEqual(expect.arrayContaining(["grid", "grid-cols-[minmax(0,1fr)_auto]", "min-h-11"]));
      expect(classes(cell)).toContain("min-w-0");
      expect(cell.contains(within(row).getByText(`${3 - index}.00%`))).toBe(false);
    }
  });
});
