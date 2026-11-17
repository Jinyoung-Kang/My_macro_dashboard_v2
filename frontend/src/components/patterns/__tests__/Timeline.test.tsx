/**
 * Timeline — 시각순 목록(작업대 실행 명세 §6, P5a — 처음 쓰는 곳 국면 판정 기록, P6 결정 로그).
 * 네 상태: 값 있음(줄마다 시각 열 <time>·종류 태그·요약·배지, 고르면 검사 칸 제목 = title), 빈 목록(emptyText), 읽는 중(placeholder Skeleton·목록 꼴
 * TimelineSkeleton role=status),
 * 오류(placeholder ErrorState·다시 시도). 톤 태그는 아이콘 + 글('주의:'), 긴 요약은 낱말 사이에서 꺾음, 좁은 화면은 대화상자, 누름 자리 44px, 강조색 없음.
 * 넓은 화면은 matchMedia 대역(WIDE_SHELL_MEDIA). 키·검사 칸 동작 자체는 목록-검사(MasterDetail.test)가 지킵니다.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorState } from "@/components/ui";
import { ScaleIcon } from "@/components/ui/icons";
import { smallTargets } from "@/lib/__tests__/touchTargetAudit";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";

import { PropertyList } from "../PropertyList";
import { Skeleton } from "../Skeleton";
import { Timeline, type TimelineEntry, TimelineSkeleton } from "../Timeline";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubWide() {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
}

const ENTRIES: TimelineEntry[] = [
  {
    key: "2026-11-16",
    at: "2026-11-16",
    dateTime: "2026-11-16",
    kind: { label: "확장", tone: "ok" },
    summary: "금리차 0.42%p · NFCI −0.49 · 하이일드 2.81%p · 순유동성 4주 +0.03조",
    title: "2026-11-16 판정 — 확장",
  },
  {
    key: "2026-11-15",
    at: "2026-11-15",
    dateTime: "2026-11-15",
    kind: { label: "후퇴 경계", tone: "warn" },
    summary: "금리차 −0.10%p · NFCI −0.40",
    title: "2026-11-15 판정 — 후퇴 경계",
    isEstimated: true,
  },
  {
    key: "2026-11-14",
    at: "2026-11-14",
    kind: { label: "판정 불가", icon: <ScaleIcon size={12} /> },
    summary: "받지 못한 입력 2",
    title: "2026-11-14 판정 — 판정 불가",
    isStale: true,
    staleReason: "수집 실패",
  },
];

function renderTimeline(props: Partial<Parameters<typeof Timeline>[0]> = {}) {
  return render(
    <Timeline
      label="판정 기록"
      entries={ENTRIES}
      renderDetail={(entry) => <PropertyList items={[{ label: "판정", value: entry.kind.label }, { label: "날짜", value: entry.at }]} />}
      {...props}
    />,
  );
}

const list = () => screen.getByRole("list", { name: "판정 기록" });
const rows = () => within(list()).getAllByRole("button");
const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/);

describe("Timeline — 값 있음", () => {
  it("줄마다 시각 열(<time dateTime>·5.5rem·tabular-nums)·종류 태그·요약 — 목록은 이름 있는 ul[data-shell-list]", () => {
    renderTimeline();
    expect(list().hasAttribute("data-shell-list")).toBe(true);
    expect(rows()).toHaveLength(3);
    const time = within(rows()[0]).getByText("2026-11-16");
    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("datetime")).toBe("2026-11-16");
    expect(tokens(time)).toEqual(expect.arrayContaining(["w-[5.5rem]", "shrink-0", "tabular-nums"]));
    // dateTime이 없으면 속성을 붙이지 않는다
    expect(within(rows()[2]).getByText("2026-11-14").hasAttribute("datetime")).toBe(false);
    expect(within(rows()[0]).getByText(/금리차 0\.42%p/)).toBeTruthy();
    expect(rows()[0].textContent).toContain("확장");
  });

  it("넓은 화면 — 줄을 누르면 검사 칸(제목 = title, 영역 이름 = '{목록 이름} — {title}')과 renderDetail", () => {
    stubWide();
    renderTimeline();
    fireEvent.click(rows()[1]);
    const region = screen.getByRole("region", { name: "판정 기록 — 2026-11-15 판정 — 후퇴 경계" });
    expect(within(region).getByRole("heading", { level: 3, name: "2026-11-15 판정 — 후퇴 경계" })).toBeTruthy();
    expect(within(region).getByText("판정")).toBeTruthy();
    expect(rows()[1].getAttribute("aria-current")).toBe("true");
  });

  it("autoSelectFirst(넓은 화면)·count·headingLevel을 목록-검사로 넘긴다", () => {
    stubWide();
    renderTimeline({ autoSelectFirst: true, count: (n) => `최근 ${n}건`, headingLevel: 4 });
    expect(screen.getByText("최근 3건")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 4, name: "2026-11-16 판정 — 확장" })).toBeTruthy();
  });

  it("톤 태그는 아이콘 + 글 — 주의는 낭독기에 '주의: ', 정상은 체크 아이콘(머리말 없음), 중립 태그에는 넘긴 아이콘", () => {
    renderTimeline();
    const [ok, warn, neutral] = rows();
    const okTag = within(ok).getByText("확장");
    expect(okTag.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(okTag.textContent).toBe("확장");
    expect(tokens(okTag)).toContain("text-ok");
    const warnTag = within(warn).getByText("후퇴 경계");
    expect(warnTag.textContent).toBe("주의: 후퇴 경계");
    expect(warnTag.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(tokens(warnTag)).toContain("text-warn");
    const neutralTag = within(neutral).getByText("판정 불가");
    expect(neutralTag.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(tokens(neutralTag)).toContain("text-text-2");
  });

  it("추정·이전 값(+ 사유) 배지가 늘 보인다", () => {
    renderTimeline();
    const [, estimated, stale] = rows();
    expect(within(estimated).getByText("추정")).toBeTruthy();
    expect(within(stale).getByText("이전 값")).toBeTruthy();
    expect(within(stale).getByText("· 수집 실패")).toBeTruthy();
    expect(within(rows()[0]).queryByText("추정")).toBeNull();
  });

  it("긴 요약은 말줄임 없이 낱말 사이에서 꺾고, 좁은 틀은 둘째 줄(basis-full)·24rem 틀부터 한 줄의 남은 폭(@sm)", () => {
    const long = "아주 긴 요약 — 장단기 금리차 역전이 이어지고 신용 스프레드가 넓어지며 순유동성이 네 주 연속 줄어 후퇴 경계 판정이 나왔습니다";
    renderTimeline({ entries: [{ ...ENTRIES[0], summary: long }] });
    const summary = within(rows()[0]).getByText(long);
    expect(tokens(summary)).toEqual(expect.arrayContaining(["break-keep", "wrap-anywhere", "min-w-0", "basis-full", "@sm:basis-auto", "@sm:flex-1"]));
    expect(tokens(summary).some((token) => token === "truncate" || token.startsWith("line-clamp"))).toBe(false);
    expect(tokens(summary.parentElement as HTMLElement)).toEqual(expect.arrayContaining(["flex", "flex-wrap"]));
  });
});

describe("Timeline — 좁은 화면", () => {
  it("줄을 누르면 title 이름의 대화상자에 renderDetail — 한 번만 열린다", () => {
    renderTimeline({ autoSelectFirst: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rows()[0].getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(rows()[2]);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    const dialog = screen.getByRole("dialog", { name: "2026-11-14 판정 — 판정 불가" });
    expect(within(dialog).getByText("2026-11-14")).toBeTruthy();
  });

  it("줄은 좁은 화면 44px — 누름 자리 감사 통과", () => {
    renderTimeline();
    expect(smallTargets(list())).toEqual([]);
  });
});

describe("Timeline — 빈 목록·읽는 중·오류", () => {
  it("기록이 없으면 emptyText — 목록이 없다", () => {
    renderTimeline({ entries: [], emptyText: "아직 판정 기록이 없습니다." });
    expect(screen.getByText("아직 판정 기록이 없습니다.")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("읽는 중이면 placeholder(Skeleton role=status) — 목록·개수 줄 없음", () => {
    renderTimeline({ count: true, placeholder: <Skeleton lines={3} label="판정 기록 불러오는 중" /> });
    expect(screen.getByRole("status", { name: "판정 기록 불러오는 중" })).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText("3건")).toBeNull();
  });

  it("목록 꼴 자리표시(TimelineSkeleton) — 줄 수만큼 글 없는 자리 줄(목록 줄과 같은 여백·구분선·좁은 화면 44px, 시각 열 5.5rem), 읽기에서 빠지고 이름 있는 상태", () => {
    renderTimeline({ count: true, placeholder: <TimelineSkeleton rows={3} label="판정 기록을 읽는 중" /> });
    const status = screen.getByRole("status", { name: "판정 기록을 읽는 중" });
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText("3건")).toBeNull();
    const list = status.querySelector("ul") as HTMLElement;
    expect(list.getAttribute("aria-hidden")).toBe("true");
    const rows = Array.from(list.querySelectorAll("li"));
    expect(rows).toHaveLength(3);
    // 목록-검사 줄과 같은 여백·구분선(마지막 줄은 선 없음), 좁은 화면 44px·넓은 화면 글 높이.
    expect(tokens(rows[0])).toEqual(expect.arrayContaining(["min-h-11", "lg:min-h-0", "px-3", "py-2", "border-b", "border-border-subtle", "lg:pt-1.5", "lg:pb-[5px]"]));
    expect(tokens(rows[2])).toEqual(expect.arrayContaining(["lg:py-1.5"]));
    expect(tokens(rows[2])).not.toContain("border-b");
    expect(rows[0].querySelector(".w-\\[5\\.5rem\\]")).not.toBeNull();
    expect(status.textContent).toBe("판정 기록을 읽는 중");
    // 줄 수는 1 이상 정수(0·NaN이면 한 줄).
    cleanup();
    render(<TimelineSkeleton rows={Number.NaN} />);
    expect(screen.getByRole("status", { name: "불러오는 중" }).querySelectorAll("li")).toHaveLength(1);
  });

  it("오류면 placeholder(ErrorState) — 다시 시도를 누를 수 있다", () => {
    const retry = vi.fn();
    renderTimeline({ placeholder: <ErrorState message="요청 실패 (HTTP 503)" onRetry={retry} /> });
    expect(screen.getByText("요청 실패 (HTTP 503)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("list")).toBeNull();
  });
});

describe("Timeline — 강조색", () => {
  it("목록·태그·검사 칸에 강조 파랑 클래스가 없다(데이터 영역)", () => {
    stubWide();
    const { container } = renderTimeline({ autoSelectFirst: true });
    const accent = [...container.querySelectorAll("[class]")].flatMap((element) =>
      (element.getAttribute("class") ?? "").split(/\s+/).filter((token) => token.includes("accent")),
    );
    expect(accent).toEqual([]);
  });
});
