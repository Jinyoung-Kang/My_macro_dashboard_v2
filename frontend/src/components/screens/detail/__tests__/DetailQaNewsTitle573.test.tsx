/**
 * QA-573: 상세 '뉴스' 탭(공용 NewsCard)의 기사 제목이 임의 크기 15px(text-[15px] font-medium leading-snug)였습니다 — 명세 §3-6이 없앤 UI 글자 단계(body-md 15)이고,
 * P4는 이름 있는 단계(text-body-md)만 옮겨 임의 클래스인 이 자리가 빠졌습니다(QA 스택 /markets/i/us10y 390·1024·1440 모두 computed 15px/20.625px).
 * 진행 기록 §P4 '남긴 것'은 홈 알림 줄 제목 15px만 적었습니다. 응답은 모두 합성 값입니다.
 *
 * 고친 뒤: 기사 제목은 기본 UI 글 body 14/20(text-body font-medium), 좁은 화면 누르는 자리 44px(TARGET_LINK)는 그대로. 상세 화면 소스에 없앤 15px
 * 단계(text-[15px]·text-body-md)가 남지 않습니다.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { NewsCard } from "../DetailParts";

const PATH = "/api/detail/news?q=synthetic";
const DETAIL_DIR = resolve(__dirname, "..");

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path === PATH
      ? Promise.resolve({
          available: true,
          news: {
            items: [
              { title: "합성 기사 하나 — 금리", url: "https://news.example/1", publisher: "Example Wire", publishedAt: null, source: "Google News" },
              { title: "합성 기사 둘 — 환율", url: "https://news.example/2", publisher: "Example Wire", publishedAt: null, source: "Yahoo Finance" },
            ],
            errors: {},
            error: null,
            fetchedAt: "2026-11-15T00:00:00Z",
          },
        })
      : new Promise(() => {}),
  );
});
afterEach(cleanup);

/** 상세 화면 폴더의 시험이 아닌 소스(.tsx·.ts). */
function detailSources(): string[] {
  return readdirSync(DETAIL_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(tsx|ts)$/.test(entry.name) && !/\.test\./.test(entry.name))
    .map((entry) => join(DETAIL_DIR, entry.name));
}

describe("QA-573 상세 뉴스 기사 제목 — 없앤 15px 단계 대신 body 14/20", () => {
  // 수정 전 실패: 제목 링크 클래스에 text-[15px]·leading-snug가 있고 text-body가 없음(재현 커밋에서는 it.fails).
  it.fails("기사 제목 링크는 text-body font-medium(15px·leading-snug 없음), 좁은 화면 누르는 자리 44px는 그대로", async () => {
    render(<NewsCard path={PATH} />);
    const links = await screen.findAllByRole("link", { name: /합성 기사/ });
    expect(links).toHaveLength(2);
    for (const link of links) {
      const tokens = (link.getAttribute("class") ?? "").split(/\s+/);
      expect(tokens).toEqual(expect.arrayContaining(["text-body", "font-medium", "min-h-11", "lg:min-h-0"]));
      expect(tokens).not.toContain("text-[15px]");
      expect(tokens).not.toContain("leading-snug");
    }
  });

  // 수정 전 실패: DetailParts.tsx에 text-[15px]가 남음(재현 커밋에서는 it.fails).
  it.fails("상세 화면 소스(시험 제외)에 없앤 15px 단계(text-[15px]·text-body-md)가 없다", () => {
    const sources = detailSources();
    expect(sources.length).toBeGreaterThan(0);
    const offenders = sources.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, index) => ({ file: file.slice(DETAIL_DIR.length + 1), line: index + 1, text: line }))
        .filter(({ text }) => /text-\[15px\]|\btext-body-md\b/.test(text))
        .map(({ file, line }) => `${file}:${line}`),
    );
    expect(offenders).toEqual([]);
  });
});
