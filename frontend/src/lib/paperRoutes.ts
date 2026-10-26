/**
 * 모의매매(미국) 화면 경로 ↔ 탭 — 순수 함수(ADR 0004). 라우트 파일(app/(dashboard)/paper/us/…)과 화면(PaperScreen)이 같이 씁니다.
 *
 * 개요는 `/paper/us`, 나머지 여섯 탭은 `/paper/us/<탭 키>`입니다(탭 키가 곧 주소 조각 — 따로 이름표를 두지 않음).
 * 옛 `/paper`는 next.config의 리디렉션이 `/paper/us`로 보냅니다(2단계에 `/paper/kr`이 생기면 `/paper`를 고르는 화면으로 쓸 수 있게
 * 임시 리디렉션). 한국 책은 2단계 — 그때 `/paper/kr`의 같은 규칙을 이 파일에 더합니다.
 */
import { PAPER_TABS, type PaperTabKey } from "./paper";

/** 모의매매(미국) 화면의 뿌리 경로 — 개요 탭. */
export const PAPER_US_PATH = "/paper/us";

/** 주소 조각이 있는 탭(개요 밖의 여섯) — `[tab]` 라우트의 generateStaticParams가 이 목록을 그대로 씁니다. 순서는 탭 순서. */
export const PAPER_TAB_SLUGS: readonly Exclude<PaperTabKey, "overview">[] = PAPER_TABS.map((tab) => tab.key).filter(
  (key): key is Exclude<PaperTabKey, "overview"> => key !== "overview",
);

/**
 * 주소 조각 → 탭. 여섯 탭 키만 받습니다 — "overview"는 `/paper/us`가 맡으므로 `/paper/us/overview`는 없는 화면(null → 404),
 * 대소문자·앞뒤 공백이 다르거나 모르는 글자도 null입니다(비슷한 주소를 조용히 다른 탭으로 열지 않음).
 */
export function paperTabFromSlug(slug: string | null | undefined): Exclude<PaperTabKey, "overview"> | null {
  if (typeof slug !== "string") return null;
  return PAPER_TAB_SLUGS.find((key) => key === slug) ?? null;
}

/** 탭 → 그 탭의 주소. 개요는 `/paper/us`, 나머지는 `/paper/us/<키>`. */
export function paperTabPath(key: PaperTabKey): string {
  return key === "overview" ? PAPER_US_PATH : `${PAPER_US_PATH}/${key}`;
}

/**
 * 지금 주소 → 탭. `/paper/us`(끝 '/' 하나는 허용)는 개요, `/paper/us/<키>`는 그 탭, 그 밖(옛 `/paper`·`/paper/kr`·모르는 조각·
 * 더 깊은 경로·null)은 null — 부르는 쪽은 null이면 지금 탭을 그대로 둡니다.
 */
export function paperTabFromPath(pathname: string | null | undefined): PaperTabKey | null {
  if (typeof pathname !== "string") return null;
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (path === PAPER_US_PATH) return "overview";
  if (!path.startsWith(`${PAPER_US_PATH}/`)) return null;
  return paperTabFromSlug(path.slice(PAPER_US_PATH.length + 1));
}
