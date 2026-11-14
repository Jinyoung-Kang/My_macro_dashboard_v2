/**
 * 정보 검색 단계 6 브라우저 확인(QA 스택)에서 찾은 관심 대상 칸의 결함 재현(계약 §6-4·§9-2·§9-5 — ADR 0041 결정 9·11). 응답은 모두 합성 값입니다.
 * jsdom은 배치를 재지 않으므로, 고친 배치가 기대는 구조(어느 칸에 무엇이 들었나·클래스)를 대조합니다. 실제 폭·위치는 QA 스택 브라우저 확인으로 봅니다.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InfoSearchWatch } from "@/hooks/useInfoSearchWatch";
import type { SearchWatchItem, SearchWatchResponse } from "@/lib/types";
import { WatchPane } from "../WatchPane";

const HOT_TOPIC: SearchWatchItem = {
  id: 7, key: "topic:합성 반도체 공급", kind: "topic", name: "합성 반도체 공급", createdAt: "2026-11-10T00:00:00+00:00",
  lastSeenAt: "2026-11-13T00:00:00+00:00", newCount: 10, hot: true, notify: false,
};
const QUIET_COMPANY: SearchWatchItem = {
  id: 8, key: "us:SYNT", kind: "company", name: "합성전자", createdAt: "2026-11-10T00:00:00+00:00", lastSeenAt: null, newCount: 0, hot: false, notify: true,
};

/** WatchPane이 읽는 칸만 둔 가짜 관심 대상 훅. */
function fakeWatch(data: SearchWatchResponse): InfoSearchWatch {
  return {
    data,
    error: null,
    reload: vi.fn(),
    setNotify: vi.fn(),
    notifyBusyId: null,
    notifyError: null,
  } as unknown as InfoSearchWatch;
}

function watchData(items: SearchWatchItem[], over: Partial<SearchWatchResponse> = {}): SearchWatchResponse {
  return { available: true, items, limits: { mine: items.length, max: 50, serverUsed: items.length, serverMax: 100 }, collecting: true, ...over };
}

afterEach(() => cleanup());

describe("QA-418 관심 대상 목록 줄 — 이름이 배지·알림 단추에 밀려 0px까지 잘리지 않음", () => {
  // QA-418: 이름 칸(min-w-0 flex-1, 한 줄 말줄임)과 '화제'·'새 글 n' 배지(shrink-0)가 한 가로줄에 놓여, 13rem 칸(대상 화면)에서 이름 폭이 0~59px로 눌리고
  // 종류 글 '주제'가 글자마다 줄바꿈되어 배지 밑에 겹침. 잘린 이름을 볼 title도 없음. jsdom은 폭을 재지 못하므로, 고친 배치의 구조 —
  // 배지는 이름 아래 줄(종류 글 옆)에 두고 이름 줄에는 이름만, 이름은 두 줄까지 줄바꿈, 전체 이름은 title, 종류 글·배지는 글자마다 끊기지 않음 — 를 대조합니다.
  // 수정 전에는 이름 span에 title이 없고(null), 배지가 이름 칸 밖(줄 단추의 가로 형제)에 있어 실패했습니다.
  it("배지는 이름 아래 줄(종류 글 옆)에, 이름 줄에는 이름만 — 이름은 두 줄까지·전체는 title, 종류 글과 배지는 줄바꿈하지 않음", () => {
    render(<WatchPane watch={fakeWatch(watchData([HOT_TOPIC, QUIET_COMPANY]))} demo={false} onOpen={() => {}} />);
    const list = screen.getByRole("list", { name: "관심 대상 목록" });
    // 낭독 이름은 그대로(이름 · 종류 · 화제 · 새 글 수 순서)
    const row = within(list).getByRole("button", { name: "합성 반도체 공급주제화제새 글 10" });
    const name = within(row).getByText("합성 반도체 공급");
    expect(name.getAttribute("title")).toBe("합성 반도체 공급");
    // 한 줄 말줄임이 아니라 두 줄까지 줄바꿈(긴 낱말도 칸 안에서 끊음)
    expect(name.className.split(/\s+/)).not.toContain("truncate");
    expect(name.className).toMatch(/(^|\s)line-clamp-2(\s|$)/);
    expect(name.className).toMatch(/wrap-anywhere/);

    const nameColumn = name.parentElement!;
    const kind = within(row).getByText("주제");
    const hot = within(row).getByText("화제");
    const count = within(row).getByText("새 글 10");
    // 배지와 종류 글은 이름 칸 안, 이름과 다른 줄(이름 span의 형제 줄)
    for (const el of [kind, hot, count]) {
      expect(nameColumn.contains(el)).toBe(true);
      expect(name.contains(el)).toBe(false);
      expect(el.className).toMatch(/(^|\s)whitespace-nowrap(\s|$)/);
    }
    expect(kind.parentElement).toBe(hot.parentElement);
    expect(kind.parentElement).toBe(count.parentElement);
    expect(kind.parentElement!.className).toMatch(/(^|\s)flex-wrap(\s|$)/);
    // 줄 단추의 가로 형제 가운데 글이 있는 칸은 이름 칸 하나뿐(배지가 이름 줄의 폭을 먼저 가져가지 않음)
    const texted = Array.from(row.children).filter((el) => (el.textContent ?? "").trim() !== "");
    expect(texted).toEqual([nameColumn]);

    // 배지가 없는 줄도 같은 구조 — 이름에 title
    const quiet = within(list).getByRole("button", { name: "합성전자기업" });
    expect(within(quiet).getByText("합성전자").getAttribute("title")).toBe("합성전자");
    expect(within(quiet).getByText("기업").className).toMatch(/(^|\s)whitespace-nowrap(\s|$)/);
  });
});

describe("QA-419 관심 대상 50개 — 목록 아래 설명 글이 거르기·최근 글을 첫 화면 밖으로 다시 밀지 않음", () => {
  /** 합성 관심 대상 n개(주제) — 첫 줄만 화제, 모두 알림 끔(서버가 알림 칸을 줌). */
  function manyTopics(count: number): SearchWatchItem[] {
    return Array.from({ length: count }, (_, at) => ({
      ...QUIET_COMPANY, id: 100 + at, key: `topic:합성 주제 ${at}`, kind: "topic", name: `합성 주제 ${at}`, notify: false, hot: at === 0,
    }));
  }
  const FULL = { mine: 50, max: 50, serverUsed: 50, serverMax: 100 };

  // QA-419: 단계 5가 목록 높이 상한(LIST_SCROLL, 224px)으로 50개일 때 대상 화면(1440x900)의 거르기와 첫 화면(390x844)의 최근 글을 첫 화면 안으로 넣었는데,
  // 단계 6이 목록 아래에 늘 펼친 설명 글(화제 정의 약 100px·알림 안내 약 80px)을 더해 거르기가 y=994, 최근 글이 y=820(아래 메뉴가 y=779부터 덮음)으로 다시 밀림.
  // jsdom은 위치를 재지 못하므로, 고친 배치의 구조 — 설명 글(새 글 수·화제·알림의 뜻)은 기본으로 접힌 안내(details) 하나에 넣고 머리 한 줄만 보이며,
  // 상태(상한 줄·정기 수집 안내·알림 실패)는 그 밖에서 늘 보임 — 를 대조합니다.
  // 수정 전에는 설명 글이 details 안에 있지 않아(closest('details')가 null) 실패했습니다.
  it("설명 글은 기본으로 접힌 안내 하나에(머리에 든 것을 글로, 좁은 화면 44px) — 상한 줄·정기 수집 안내는 그 밖에서 늘 보임", () => {
    render(<WatchPane watch={fakeWatch(watchData(manyTopics(50), { limits: FULL, collecting: false }))} demo={false} onOpen={() => {}} />);
    const details = screen.getByText(/화제 = 지난 24시간에 처음 받은 글이 5건 이상/).closest("details");
    expect(details).not.toBeNull();
    expect(details!.hasAttribute("open")).toBe(false);
    expect(details!.contains(screen.getByText(/새 글 수는 마지막으로 그 대상의 타임라인을 연 뒤/))).toBe(true);
    expect(details!.contains(screen.getByText(/알림을 켠 대상은 새 글이 들어오면 알림함에 한 줄을 남깁니다/))).toBe(true);
    // 머리(summary — 기본 요소라 키보드로 여닫음): 무엇이 들었는지 글로, 좁은 화면 누름 자리 44px, 포커스 링
    const summary = details!.querySelector("summary");
    expect(summary?.textContent).toBe("새 글 수·화제·알림 안내");
    expect(summary!.className).toMatch(/(^|\s)min-h-11(\s|$)/);
    expect(summary!.className).toMatch(/(^|\s)lg:min-h-0(\s|$)/);
    expect(summary!.className).toMatch(/focus-visible:outline-2/);
    // 늘 보이는 것 — 목록, 상한 줄, 정기 수집 안내(새 글이 모이지 않는 곳이라는 상태)
    expect(details!.contains(screen.getByRole("region", { name: "관심 대상 목록 (위아래 스크롤)" }))).toBe(false);
    expect(details!.contains(screen.getByText("내 목록 50 / 50 · 서버 전체 50 / 100"))).toBe(false);
    expect(details!.contains(screen.getByText(/정기 수집은 서버에서만 돕니다/))).toBe(false);
    // 안내 밖에 늘 펼친 설명 글은 없음 — 밖의 글 줄은 상한 줄과 정기 수집 안내뿐
    const outside = Array.from(details!.parentElement!.children)
      .filter((el) => el.tagName === "P")
      .map((el) => el.textContent);
    expect(outside).toEqual(["내 목록 50 / 50 · 서버 전체 50 / 100", expect.stringContaining("정기 수집은 서버에서만 돕니다")]);
  });

  // QA-419: 머리 글은 든 것만 말하고(화제인 대상이 없으면 '화제'를, 알림 칸을 모르면 '알림'을 뺌), 알림 실패 글(role=alert)은 접힌 안내 밖에 남음.
  // 수정 전에는 접힌 안내(summary)가 없어 실패했습니다.
  it("머리 글은 든 것만 — 화제·알림이 없으면 '새 글 수 안내', 알림 실패 글은 안내 밖(role=alert)", () => {
    const quiet = manyTopics(3).map((item) => ({ ...item, hot: false }));
    const watch = {
      ...fakeWatch(watchData(quiet)),
      notifyError: { id: 100, from: "list", message: "이 계정으로는 할 수 없습니다" },
    } as unknown as InfoSearchWatch;
    render(<WatchPane watch={watch} demo={false} onOpen={() => {}} />);
    const summary = screen.getByText("새 글 수·알림 안내");
    expect(summary.tagName).toBe("SUMMARY");
    expect(screen.queryByText(/화제 = /)).toBeNull();
    expect(summary.closest("details")!.contains(screen.getByRole("alert"))).toBe(false);
    cleanup();

    const unknownNotify = quiet.map((item) => ({ ...item, notify: undefined }));
    render(<WatchPane watch={fakeWatch(watchData(unknownNotify))} demo={false} onOpen={() => {}} />);
    expect(screen.getByText("새 글 수 안내").tagName).toBe("SUMMARY");
    expect(screen.queryByText(/알림을 켠 대상은/)).toBeNull();
  });
});
