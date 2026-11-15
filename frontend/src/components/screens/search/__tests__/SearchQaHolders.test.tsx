/**
 * 정보 검색 보유 탭 — 13F 보유 기관을 이름으로 찾아 한 줄도 없을 때의 안내(QA-436, 계약 §5). 응답은 모두 합성 값입니다(실제 기관의 자료를 쓰지 않음).
 *
 * 보유 탭은 사용자가 아무것도 치지 않고 대상의 영문 이름으로 찾습니다. 13F 공시 이름은 제출자가 잘라 적거나 줄여 적어 이름으로 못 찾을 수 있으므로,
 * 0건이면 무엇으로 찾았는지와 그 한계를 적고 '보유한 곳이 없다'고 단정하지 않습니다. 직접 치는 검색의 안내('대문자 영문입니다')는 이 탭에 맞지 않습니다.
 */
import { cleanup, render, screen } from "@testing-library/react";
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

const QUERY = "SYNTHETIC EXAMPLE FINANCIAL GROUP";

const COMPANY: SearchEntity = {
  key: "us:SYNF", kind: "company", name: "합성금융그룹", nameKo: "합성금융그룹", nameEn: "Synthetic Example Financial Group, Inc.", aliases: [],
  description: null, ids: { ticker: "SYNF", market: "us", stockCode: null, cik: null, dartCorpCode: null, wikidata: null },
  links: [], sources: [],
};

/** 백엔드가 이름으로 찾아 0건일 때의 응답 모양(GuruService.holders — 직접 치는 검색의 안내 글이 함께 옴). */
const NO_MATCH: GuruHoldersResponse = {
  query: QUERY,
  available: false,
  rows: [],
  totalMatches: 0,
  truncated: false,
  message: "그 이름을 포함한 보유 종목이 없습니다. 13F 공시 이름은 대문자 영문입니다(예: APPLE, NVIDIA).",
};

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path === endpoints.institution.guruHolders(QUERY) ? Promise.resolve(NO_MATCH) : new Promise(() => {}),
  );
});
afterEach(cleanup);

describe("보유 탭 — 이름으로 찾은 13F 보유 줄이 없을 때(QA-436)", () => {
  // QA-436: 0건이면 백엔드의 직접 치는 검색 안내('그 이름을 포함한 보유 종목이 없습니다. 13F 공시 이름은 대문자 영문입니다…')를 그대로 보여,
  // 아무것도 치지 않은 탭에서 '보유 종목이 없다'고 단정했습니다(공시 이름이 잘려 못 찾은 경우에도).
  // 수정 전 실패: 찾은 이름을 적은 안내가 없고 '대문자 영문'·'보유 종목이 없습니다'가 보임(재현 커밋에서는 it.fails).
  it("찾은 이름과 '줄여 적은 공시 이름은 찾지 못함'을 적고, 보유한 곳이 없다고 단정하지 않는다", async () => {
    render(<HoldingsPanel entity={COMPANY} loading={false} />);
    await screen.findAllByText(/없습니다/);

    const status = screen.getByRole("status");
    expect(status.textContent).toContain(`‘${QUERY}’ 이름으로 찾은 13F 보유 줄이 없습니다`);
    expect(status.textContent).toContain("앞부분만 남기고 잘린 공시 이름은 함께 찾지만");
    expect(status.textContent).toContain("보유한 곳이 없다고 단정할 수 없습니다");
    expect(screen.queryByText(/대문자 영문/)).toBeNull();
    expect(screen.queryByText(/보유 종목이 없습니다|보유한 곳이 없습니다/)).toBeNull();
  });

  it("줄이 있으면 머리에 찾은 이름과 '잘린 공시 이름 포함'을 적는다(백엔드가 잘린 공시 이름도 앞부분으로 찾음)", async () => {
    const reportDate = rangeStart("30d", kstToday(Date.now()));
    const found: GuruHoldersResponse = {
      query: QUERY, available: true, totalMatches: 1, truncated: false,
      rows: [{ institution: "합성 자산운용", cik: "0000000001", name: "SYNTHETIC EXAMPLE FINANCIAL GRO", cusip: "000000101", weight: 1.25, value: 1_000_000, reportDate }],
    };
    api.apiGetShared.mockImplementation((path: string) =>
      path === endpoints.institution.guruHolders(QUERY) ? Promise.resolve(found) : new Promise(() => {}),
    );
    render(<HoldingsPanel entity={COMPANY} loading={false} />);

    const heading = await screen.findByRole("heading", { name: /13F 보유 기관/ });
    expect(heading.textContent).toBe(`13F 보유 기관 — ‘${QUERY}’ 이름으로 찾은 줄(잘린 공시 이름 포함, 비중 순)`);
    expect(screen.getByText(/SYNTHETIC EXAMPLE FINANCIAL GRO · 보고일/)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
