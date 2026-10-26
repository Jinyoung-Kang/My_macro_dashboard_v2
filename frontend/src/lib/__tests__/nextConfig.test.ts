/**
 * next.config.mjs의 리디렉션 — 옛 주소의 북마크·공유 링크가 404가 되지 않게(계획서 §4 1단계 "옛 /paper 북마크는 새 경로로").
 *
 *  - 옛 /paper → /paper/us는 임시(307) 하나 — 2단계에 /paper를 시장 고르는 화면으로 쓸 수 있게 영구(308)로 두지 않음.
 *    옛 app/(dashboard)/paper/page.tsx는 지웠으므로 이 줄이 빠지면 /paper는 바로 404입니다.
 *  - 어떤 source도 /paper/us·그 아래 탭 주소에 맞지 않음 — `/paper/:path*`처럼 넓히면 /paper/us까지 맞아 끝없이 되돌아갑니다.
 *  - 2단계의 /paper/kr도 가로채지 않음, 합쳐진 메뉴의 옛 주소 세 개(영구)는 그대로.
 *
 * 맞는지는 Next가 redirects의 source를 맞출 때 쓰는 것과 같은 getPathMatch(strict·removeUnnamedParams —
 * next/dist/server/lib/router-utils/filesystem.js의 buildCustomRoute)로 봅니다. dist 안 경로라 next 판을 올리면 이 import를 확인합니다.
 */
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { describe, expect, it } from "vitest";

import { PAPER_TAB_SLUGS, PAPER_US_PATH, paperTabPath } from "../paperRoutes";

type Redirect = { source: string; destination: string; permanent: boolean };

async function loadRedirects(): Promise<Redirect[]> {
  // next.config.mjs는 JS이고 tsconfig가 allowJs:false라 선언이 없습니다 — 경로를 string 변수로 넘겨 타입 검사가 모듈을 찾지 않게 합니다.
  const path: string = "../../../next.config.mjs";
  const config = (await import(/* @vite-ignore */ path)).default as { redirects: () => Promise<Redirect[]> };
  return config.redirects();
}

/** 이 source가 그 경로에 맞는가(Next의 redirects 맞추기와 같은 옵션). */
function matches(source: string, pathname: string): boolean {
  return getPathMatch(source, { strict: true, removeUnnamedParams: true })(pathname) !== false;
}

/** 모의매매(미국) 화면의 주소 전부 — 개요 + 여섯 탭. */
const PAPER_US_PATHS = [PAPER_US_PATH, ...PAPER_TAB_SLUGS.map((slug) => paperTabPath(slug))];

describe("next.config 리디렉션", () => {
  it("옛 /paper → /paper/us 하나, 임시(permanent:false = 307)", async () => {
    const redirects = await loadRedirects();
    const paper = redirects.filter((entry) => matches(entry.source, "/paper"));
    expect(paper).toEqual([{ source: "/paper", destination: "/paper/us", permanent: false }]);
  });

  it("어떤 source도 /paper/us와 그 아래 탭 주소에 맞지 않는다 — 맞으면 끝없는 리디렉션", async () => {
    const redirects = await loadRedirects();
    expect(PAPER_US_PATHS).toHaveLength(7);
    for (const pathname of PAPER_US_PATHS) {
      expect(redirects.filter((entry) => matches(entry.source, pathname)), pathname).toEqual([]);
    }
    // 2단계의 한국 책 주소도 가로채지 않습니다.
    expect(redirects.filter((entry) => matches(entry.source, "/paper/kr"))).toEqual([]);
  });

  it("도착지는 다시 리디렉션되지 않는다(사슬·반복 없음)", async () => {
    const redirects = await loadRedirects();
    for (const entry of redirects) {
      expect(redirects.filter((other) => matches(other.source, entry.destination)), entry.destination).toEqual([]);
    }
  });

  it("합쳐진 메뉴의 옛 주소 세 개는 그대로(영구)", async () => {
    const redirects = await loadRedirects();
    expect(redirects).toEqual(expect.arrayContaining([
      { source: "/ai/test", destination: "/connections", permanent: true },
      { source: "/toss", destination: "/connections", permanent: true },
      { source: "/guru", destination: "/style", permanent: true },
    ]));
    expect(redirects).toHaveLength(4);
  });
});
