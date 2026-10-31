/**
 * 장 시계 — 상단바의 장 상태 칩 둘(명세 docs/specs/2026-10-31-v2-coinbase-ui.md §6). 칩 글(시장 이름·상태·시각), 상태 점의 톤,
 * title(전체 이름·현지 날짜·시각·안내), 그림 문자(국기·여신상)가 없음을 봅니다.
 *
 * 시각은 Date만 가짜로 고정합니다(시계를 기다리지 않음 — QA-147·148). 공휴일 응답은 목으로 바로 주고 act 뒤에 읽습니다.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);

import { MarketClock } from "../MarketClock";

const KR_HOLIDAYS = "/api/calendar/kr-holidays";
/** 공휴일 응답 — 없으면 끝나지 않습니다(읽는 중). */
let holidays: unknown;

const settled = () => act(async () => {});

/** 시장 이름 글이 든 칩(title이 있는 바깥 span). */
const chip = (market: "KOSPI" | "NASDAQ") => screen.getByText(market).closest("[title]") as HTMLElement;
/** 칩 안의 상태 점(장식) — 톤 글자색 클래스로 칠합니다. */
const dotTone = (element: HTMLElement) => {
  const dot = element.querySelector("span[aria-hidden='true'].rounded-full");
  return ["text-ok", "text-warn", "text-danger", "text-text-3"].find((tone) => dot?.classList.contains(tone)) ?? null;
};

async function renderAt(iso: string) {
  vi.setSystemTime(new Date(iso));
  const view = render(<MarketClock />);
  await settled();
  return view;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  holidays = undefined;
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path.startsWith(KR_HOLIDAYS) && holidays !== undefined ? Promise.resolve(holidays) : new Promise(() => {}),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("장 상태 칩", () => {
  it("한국 화요일 10:00 — KOSPI 거래 중(정상 점), 뉴욕 월요일 20:00 — NASDAQ 애프터마켓(주의 점)", async () => {
    await renderAt("2026-11-03T01:00:00Z");

    const kospi = chip("KOSPI");
    expect(kospi.textContent).toBe("KOSPI·거래 중10:00:00");
    expect(dotTone(kospi)).toBe("text-ok");
    expect(kospi.getAttribute("title")).toBe("한국 (KOSPI) 2026-11-03 10:00:00 — 거래 중");

    const nasdaq = chip("NASDAQ");
    expect(nasdaq.textContent).toBe("NASDAQ·애프터마켓20:00:00");
    expect(dotTone(nasdaq)).toBe("text-warn");
    // 현지 날짜는 시장마다 다르다 — 칩에는 시각만, 날짜는 title에.
    expect(nasdaq.getAttribute("title")).toBe("뉴욕 (NASDAQ) 2026-11-02 20:00:00 — 애프터마켓");
  });

  it("주말이면 둘 다 '휴장 (주말)' — 중립 점", async () => {
    await renderAt("2026-10-31T16:29:00Z");

    for (const market of ["KOSPI", "NASDAQ"] as const) {
      expect(chip(market).textContent).toContain("휴장 (주말)");
      expect(dotTone(chip(market))).toBe("text-text-3");
    }
  });

  it("시장 이름은 글이 나른다 — 국기·여신상 같은 그림 문자가 없다", async () => {
    const { container } = await renderAt("2026-11-03T01:00:00Z");
    expect(container.textContent).not.toMatch(/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u);
  });

  it("시각 칸은 좁은 화면과 xl 이상에서만 보이고(lg 한 줄에서는 숨김), 숫자 폭이 같다 — 가장 좁은 화면은 초를 숨긴다", async () => {
    await renderAt("2026-11-03T01:00:00Z");
    const time = screen.getByText((_, element) => element?.tagName === "SPAN" && element.textContent === "10:00:00" && !element.hasAttribute("title"));
    expect(time.className).toContain("tabular-nums");
    expect(time.className).toContain("lg:hidden");
    expect(time.className).toContain("xl:inline");
    expect(within(chip("KOSPI")).getByText(":00").className).toContain("hidden sm:inline");
  });
});

describe("한국 공휴일 목록", () => {
  it("그 해 목록이 내장 표에도 응답에도 없으면 안내 아이콘을 붙이고 안내 글은 title에", async () => {
    await renderAt("2030-03-05T01:00:00Z");   // 한국 2030-03-05(화) 10:00 — 내장 표 밖의 해

    const kospi = chip("KOSPI");
    expect(kospi.querySelector("svg[aria-hidden='true']")).toBeTruthy();
    expect(kospi.getAttribute("title")).toContain("2030년 공휴일 목록이 없어 양력 고정 휴일만 반영했습니다");
    expect(chip("NASDAQ").querySelector("svg")).toBeNull();
  });

  it("백엔드가 준 공식 목록이 있으면 그 날을 휴장으로 보고 안내가 없다", async () => {
    holidays = {
      available: true,
      years: { "2030": { announced: true, holidays: [{ date: "2030-03-05", name: "임시공휴일" }] } },
    };
    await renderAt("2030-03-05T01:00:00Z");

    const kospi = chip("KOSPI");
    expect(kospi.textContent).toContain("휴장 (공휴일)");
    expect(dotTone(kospi)).toBe("text-text-3");
    expect(kospi.querySelector("svg")).toBeNull();
    expect(kospi.getAttribute("title")).not.toContain("공휴일 목록이 없어");
  });
});
