/**
 * 정보 검색 보유 탭의 QA 결함 재현·고정 시험(QA-432 — 계약 §5, ADR 0041 결정 11). 응답은 모두 합성 값입니다(실제 기관·법인의 자료를 쓰지 않음).
 * jsdom은 배치를 재지 못하므로, 고침이 세우는 구조(클래스·요소의 자리)를 대조하고 실제 폭·겹침은 QA 스택 브라우저(390·1280)로 확인합니다.
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

import { institutionHref } from "@/lib/detail";
import { endpoints } from "@/lib/endpoints";
import { kstToday, rangeStart } from "@/lib/infoSearch";
import type { GuruHoldersResponse, SearchEntity } from "@/lib/types";
import { HoldingsPanel } from "../HoldingsPanel";

/** 요소의 클래스 낱말(접두가 붙은 것은 따로 — 'truncate'와 'lg:truncate'는 다른 낱말). */
const classes = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

const COMPANY: SearchEntity = {
  key: "us:SYNT", kind: "company", name: "합성전자", nameKo: "합성전자", nameEn: "Synthetic Example Corp", aliases: [], description: null,
  ids: { ticker: "SYNT", market: "us", stockCode: null, cik: null, dartCorpCode: null, wikidata: null },
  links: [], sources: [],
};

/** 띄어쓰기 없는 긴 기관 이름(QA 브라우저 확인에 쓴 모의 값)과 띄어쓰기가 있는 한국어·영문 이름. */
const UNBROKEN = "QAFictionalCapitalManagementHoldingsWithoutSpacesLimited";
const SPACED = "합성 자산운용 (Example Capital Partners)";

function holders(): GuruHoldersResponse {
  // 최근 2년 안의 보고일(오늘 KST에서 30일 전) — 2년 규칙(계약 §5)에 걸리지 않게.
  const reportDate = rangeStart("30d", kstToday(Date.now()));
  return {
    available: true,
    query: "SYNTHETIC EXAMPLE",
    rows: [
      { institution: UNBROKEN, cik: "0000000001", name: "SYNTHETIC EXAMPLE CORP", cusip: "000000001", weight: 44.34, value: 1_000_000, reportDate },
      { institution: SPACED, cik: "0000000002", name: "SYNTHETIC EXAMPLE CORP", cusip: "000000001", weight: 38.66, value: 900_000, reportDate },
    ],
  };
}

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path === endpoints.institution.guruHolders("SYNTHETIC EXAMPLE") ? Promise.resolve(holders()) : new Promise(() => {}),
  );
});
afterEach(cleanup);

describe("보유 탭 — 기업의 13F 보유 기관 줄(QA-432)", () => {
  // QA-432: 기관 이름 링크가 LINK(inline-flex)만 써서 줄바꿈 규칙이 없었습니다 — inline-flex 상자는 띄어쓰기 없는 가장 긴 낱말의 폭(min-content)보다
  // 줄지 못해 min-w-0 이름 칸을 넘었고, 1280·390 화면에서 오른쪽 숫자 칸('44.34%')과 글자가 겹쳤습니다(390에서 목록 scrollWidth 391 > clientWidth 296).
  // 수정 전 실패: 링크에 max-w-full이 없고, 이름 글이 링크 상자에 바로 들어 있어 줄바꿈 규칙(break-keep·wrap-anywhere)을 실은 안쪽 칸이 없음(재현 커밋에서는 it.fails).
  it.fails("이름은 제 칸 안에서 줄바꿈(한국어는 낱말 사이, 칸보다 긴 낱말만 안에서 끊음 — 말줄임 없음), 링크 상자는 칸 폭까지, 숫자는 따로 칸 — 44px·포커스 링 그대로", async () => {
    render(<HoldingsPanel entity={COMPANY} loading={false} />);
    await screen.findByRole("heading", { name: /13F 보유 기관/ });

    for (const [institution, cik, weight] of [[UNBROKEN, "0000000001", "44.34%"], [SPACED, "0000000002", "38.66%"]] as const) {
      const link = screen.getByRole("link", { name: institution });
      expect(link.getAttribute("href")).toBe(institutionHref(cik));

      // 줄: 이름 칸(줄어드는 칸)과 숫자 칸(제 폭)의 두 칸 격자, lg 미만 44px.
      const cell = link.parentElement!;
      const row = cell.parentElement!;
      expect(row.tagName).toBe("LI");
      expect(classes(row)).toEqual(expect.arrayContaining(["grid", "grid-cols-[minmax(0,1fr)_auto]", "min-h-11"]));
      expect(classes(cell)).toContain("min-w-0");
      const number = within(row).getByText(weight);
      expect(cell.contains(number)).toBe(false);

      // 따로 선 링크라 lg 미만 누르는 자리 44px, 포커스 링(바깥 outline)은 링크에 그대로.
      expect(classes(link)).toEqual(expect.arrayContaining(["min-h-11", "lg:min-h-0", "focus-visible:outline-2", "focus-visible:outline-offset-2"]));
      // 링크 상자는 이름 칸 폭을 넘지 않음.
      expect(classes(link)).toContain("max-w-full");
      // 이름 글은 줄바꿈 규칙을 실은 안쪽 칸(inline-flex 상자의 항목)에 — 그래야 항목의 최소 폭이 긴 낱말 폭이 아니라 칸 안에서 끊긴 폭이 됨.
      const name = within(link).getByText(institution);
      expect(name).not.toBe(link);
      expect(classes(name)).toEqual(expect.arrayContaining(["min-w-0", "break-keep", "wrap-anywhere"]));
      expect(classes(name)).not.toContain("truncate");
    }
  });
});
