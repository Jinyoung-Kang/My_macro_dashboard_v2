/**
 * 모의매매 화면 경로 ↔ 시장·탭 — 순수 함수(ADR 0004). 라우트 파일(app/(dashboard)/paper/us/…·paper/kr/…)과 화면(PaperScreen)이 같이 씁니다.
 *
 * 시장마다 개요는 `/paper/us`·`/paper/kr`, 나머지 여섯 탭은 `/paper/<시장>/<탭 키>`입니다(탭 키가 곧 주소 조각 — 따로 이름표를 두지 않음,
 * 한국도 미국과 같은 일곱 탭 — 사용자 결정 2026-10-29). 옛 `/paper`는 next.config의 리디렉션이 `/paper/us`로 보냅니다(임시 리디렉션 —
 * `/paper`를 시장 고르는 화면으로 쓸 수 있게).
 */
import { PAPER_TABS, type PaperTabKey } from "./paper";
import type { PaperMarketCode } from "./paperMarket";

/** 모의매매(미국) 화면의 뿌리 경로 — 개요 탭. */
export const PAPER_US_PATH = "/paper/us";
/** 모의매매(한국) 화면의 뿌리 경로 — 개요 탭(2단계 명세 §4-16). */
export const PAPER_KR_PATH = "/paper/kr";

/** 그 시장 화면의 뿌리 경로(개요). */
export function paperMarketPath(market: PaperMarketCode = "US"): string {
  return market === "KR" ? PAPER_KR_PATH : PAPER_US_PATH;
}

/** 주소 조각이 있는 탭(개요 밖의 여섯) — `[tab]` 라우트의 generateStaticParams가 이 목록을 그대로 씁니다. 순서는 탭 순서. 두 시장 같음. */
export const PAPER_TAB_SLUGS: readonly Exclude<PaperTabKey, "overview">[] = PAPER_TABS.map((tab) => tab.key).filter(
  (key): key is Exclude<PaperTabKey, "overview"> => key !== "overview",
);

/**
 * 주소 조각 → 탭. 여섯 탭 키만 받습니다 — "overview"는 뿌리 경로가 맡으므로 `/paper/us/overview`는 없는 화면(null → 404),
 * 대소문자·앞뒤 공백이 다르거나 모르는 글자도 null입니다(비슷한 주소를 조용히 다른 탭으로 열지 않음).
 */
export function paperTabFromSlug(slug: string | null | undefined): Exclude<PaperTabKey, "overview"> | null {
  if (typeof slug !== "string") return null;
  return PAPER_TAB_SLUGS.find((key) => key === slug) ?? null;
}

/** 탭 → 그 탭의 주소. 개요는 뿌리 경로(`/paper/us`·`/paper/kr`), 나머지는 `<뿌리>/<키>`. 시장 기본값은 미국. */
export function paperTabPath(key: PaperTabKey, market: PaperMarketCode = "US"): string {
  const root = paperMarketPath(market);
  return key === "overview" ? root : `${root}/${key}`;
}

/** 지금 주소의 모의매매 시장·탭. */
export interface PaperRoute {
  market: PaperMarketCode;
  tab: PaperTabKey;
}

/**
 * 지금 주소 → 시장·탭. `/paper/us`·`/paper/kr`(끝 '/' 하나는 허용)는 그 시장 개요, `<뿌리>/<키>`는 그 탭, 그 밖(옛 `/paper`·모르는 조각·
 * 대소문자가 다른 시장(`/paper/KR`)·더 깊은 경로·null)은 null — 부르는 쪽은 null이면 지금 탭을 그대로 둡니다.
 */
export function paperRouteFromPath(pathname: string | null | undefined): PaperRoute | null {
  if (typeof pathname !== "string") return null;
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  for (const market of ["US", "KR"] as const) {
    const root = paperMarketPath(market);
    if (path === root) return { market, tab: "overview" };
    if (path.startsWith(`${root}/`)) {
      const tab = paperTabFromSlug(path.slice(root.length + 1));
      return tab ? { market, tab } : null;
    }
  }
  return null;
}

/**
 * 지금 주소 → 그 시장 화면의 탭. 주소가 다른 시장의 화면이면 null(예: 미국 화면(기본값)에서 `/paper/kr`은 null — 다른 시장 주소로
 * 이 화면의 탭을 바꾸지 않음). 규칙은 {@link paperRouteFromPath}와 같습니다.
 */
export function paperTabFromPath(pathname: string | null | undefined, market: PaperMarketCode = "US"): PaperTabKey | null {
  const route = paperRouteFromPath(pathname);
  return route && route.market === market ? route.tab : null;
}
