/**
 * 정보 검색 보유 탭 — 대상 풀기가 이름을 얻지 못해 name이 키의 티커·종목코드로 채워진 대상(QA-436 후속, 계약 §5). 응답은 모두 합성 값입니다.
 *
 * 수집기(search_entities finish)는 한글·영문 이름을 하나도 얻지 못하면 name을 대체값(us: 티커, kr: 종목코드)으로 채웁니다(SEC 표·유니버스에 없는
 * 티커, 출처 일시 실패, DART 저장본 읽기 실패 때). 이 값은 영문 이름이 아니므로 보유 탭은 티커로 찾았다고 적어야 합니다.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { endpoints } from "@/lib/endpoints";
import { holdersQuery } from "@/lib/infoSearch";
import type { GuruHoldersResponse, SearchEntity } from "@/lib/types";
import { HoldingsPanel } from "../HoldingsPanel";

const NO_IDS: SearchEntity["ids"] = { ticker: null, market: null, stockCode: null, cik: null, dartCorpCode: null, wikidata: null };

/** 미국 티커만 알고 이름을 얻지 못한 합성 대상 — name이 티커(수집기 대체값). */
const US_FALLBACK: SearchEntity = {
  key: "us:SYNKF", kind: "company", name: "SYNKF", nameKo: null, nameEn: null, aliases: [], description: null,
  ids: { ...NO_IDS, ticker: "SYNKF", market: "us" }, links: [], sources: [],
};

/** 국내 종목코드만 알고 이름을 얻지 못한 합성 대상 — name이 종목코드(수집기 대체값). */
const KR_FALLBACK: SearchEntity = {
  key: "kr:999990", kind: "company", name: "999990", nameKo: null, nameEn: null, aliases: [], description: null,
  ids: { ...NO_IDS, ticker: "999990", market: "kr", stockCode: "999990" }, links: [], sources: [],
};

const noMatch = (query: string): GuruHoldersResponse => ({
  query, available: false, rows: [], totalMatches: 0, truncated: false,
  message: "그 이름을 포함한 보유 종목이 없습니다. 13F 공시 이름은 대문자 영문입니다(예: APPLE, NVIDIA).",
});

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    for (const query of ["SYNKF", "999990"]) if (path === endpoints.institution.guruHolders(query)) return Promise.resolve(noMatch(query));
    return new Promise(() => {});
  });
});
afterEach(cleanup);

describe("보유 탭 검색어 — name이 키의 티커·종목코드(대체값)이면 영문 이름이 아니라 티커로 찾는다(QA-436 후속)", () => {
  // QA-436 후속: holdersQuery가 한글이 없는 name을 모두 영문 이름으로 봐서, 이름을 얻지 못해 name이 티커·종목코드로 채워진 대상도 by 'name'이 됐습니다.
  // 수정 전 실패: { text: "SYNKF", by: "name" }·{ text: "999990", by: "name" }(재현 커밋에서는 it.fails).
  it.fails("대체값 name(대소문자 무관)은 영문 이름으로 보지 않고 티커로 찾는다", () => {
    expect(holdersQuery(US_FALLBACK)).toEqual({ text: "SYNKF", by: "ticker" });
    expect(holdersQuery(KR_FALLBACK)).toEqual({ text: "999990", by: "ticker" });
    expect(holdersQuery({ ...US_FALLBACK, name: "synkf" })).toEqual({ text: "SYNKF", by: "ticker" });
  });

  it("대체값이 아닌 한글 없는 이름은 지금처럼 영문 이름으로 찾는다(넓히지 않음)", () => {
    expect(holdersQuery({ ...US_FALLBACK, name: "Synthetic Kappa Foods Inc." })).toEqual({ text: "SYNTHETIC KAPPA FOODS", by: "name" });
    expect(holdersQuery({ ...US_FALLBACK, nameEn: "Synthetic Kappa Foods Inc." })).toEqual({ text: "SYNTHETIC KAPPA FOODS", by: "name" });
  });

  // QA-436 후속: 화면은 '‘SYNKF’ 이름으로 찾은 13F 보유 줄이 없습니다'와 잘린·줄여 적은 이름 설명을 보였습니다(티커로 찾았는데).
  // 수정 전 실패: 안내가 '이름으로 찾은'이고 '13F 공시 이름에는 티커가 적히지 않아'가 없음(재현 커밋에서는 it.fails).
  it.fails.each([
    ["us:SYNKF", US_FALLBACK, "SYNKF"],
    ["kr:999990", KR_FALLBACK, "999990"],
  ] as const)("%s — 0건 안내는 티커로 찾았다는 것과 그 까닭을 적는다", async (_key, entity, ticker) => {
    const { container } = render(<HoldingsPanel entity={entity} loading={false} />);
    await waitFor(() => expect(screen.queryByText(/불러오는 중/)).toBeNull());

    expect(container.textContent).not.toContain("이름으로 찾은");
    expect(container.textContent).not.toContain("줄여 적은 이름");
    const status = screen.getByRole("status");
    expect(status.textContent).toContain(`‘${ticker}’ 티커로 찾은 13F 보유 줄이 없습니다`);
    expect(status.textContent).toContain("13F 공시 이름에는 티커가 적히지 않아");
    expect(status.textContent).toContain("보유한 곳이 없다고 단정할 수 없습니다");
  });
});
