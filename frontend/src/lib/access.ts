/**
 * 화면에서 메뉴를 고르는 규칙 — React를 모르는 순수 함수(ADR 0004).
 *
 * 막는 것은 백엔드의 경로별 접근 정책(ADR 0010)입니다. 여기서는 일반 회원이 눌러 봐야 403만 받는 메뉴·버튼을
 * 처음부터 보이지 않게 할 뿐입니다. 백엔드 정책과 어긋나면 "버튼은 보이는데 403"이 되므로, 운영 메뉴는
 * 백엔드에서 운영자 전용인 경로만 부르는 화면만 적습니다.
 */
import type { SessionResponse, SessionUser } from "./types";

/**
 * 운영자만 보는 메뉴 — 수집 실행·내부 상태(/api/status*)와 키 설정 진단·유료 AI 시험 호출을 부르는 화면,
 * 그리고 🧪 모의 알고리즘 매매(/api/paper/* 전부 운영자 전용).
 */
export const OWNER_ONLY_MENUS = ["/status", "/connections", "/admin/users", "/paper"] as const;

/**
 * 계정이 있는 사용자만 보는 메뉴 — 데모 열람(ADR 0013)은 계정·세션이 없어, 내 계정 화면이 열자마자 홈으로 돌려보냅니다.
 * 옛 사이드바는 데모에게 내 계정 링크를 두지 않았습니다(계정 영역). 셸의 더보기 목록도 같게 둡니다.
 */
export const ACCOUNT_MENUS = ["/account"] as const;

/** 유료 등급 메뉴 — 무료 회원에게는 🔒을 붙입니다(눌러도 되며, 화면이 유료 안내를 띄움). */
export const PRO_MENUS = ["/ai/report"] as const;

/**
 * 메뉴 href가 목록의 경로(또는 그 아래 경로)인가 — 앞부분 일치(`/paper` → `/paper/us`·`/paper/us/settings`).
 * 정확히 같을 때만 맞추면 탭·하위 화면이 `/paper/us`처럼 한 단계 내려갈 때 운영자 전용 메뉴가 회원에게 보였습니다.
 * `/` 경계로만 자릅니다(`/statusx`는 `/status`가 아님).
 */
function matchesMenu(href: string, menus: readonly string[]): boolean {
  return menus.some((menu) => href === menu || href.startsWith(`${menu}/`));
}

/** 무료 회원에게 잠긴 메뉴인가. */
export function lockedFor(user: SessionUser | null | undefined, href: string): boolean {
  if (!user || user.role === "OWNER" || user.tier === "PRO") return false;
  return matchesMenu(href, PRO_MENUS);
}

export function isOwner(user: SessionUser | null | undefined): boolean {
  return user?.role === "OWNER";
}

/** 이 사용자에게 보여 줄 메뉴. 사용자를 모르면(세션 응답 전) 운영 메뉴는 숨기고, 데모 열람에게는 내 계정도 숨깁니다. */
export function visibleMenus<T extends { href: string }>(menus: readonly T[], user: SessionUser | null | undefined): T[] {
  if (isOwner(user)) return [...menus];
  return menus.filter(
    (menu) => !matchesMenu(menu.href, OWNER_ONLY_MENUS) && !(isDemo(user) && matchesMenu(menu.href, ACCOUNT_MENUS)),
  );
}

/** 데모 열람인가(ADR 0013) — 계정 없이 읽기만 하는 방문자. */
export function isDemo(user: SessionUser | null | undefined): boolean {
  return user?.demo === true;
}

/** 데모 열람에서 쓰기 버튼 옆에 적는 안내. 백엔드의 403 문구와 같은 뜻입니다. */
export const DEMO_READ_ONLY = "데모에서는 조회만 가능합니다";

/**
 * 로그인 없이 여는 로컬 실행인가(ADR 0016). 세션 응답의 noLogin이 정확히 true일 때만입니다 — 값이 없는
 * 이전 백엔드나 false인 AWS 웹 데모·QA 스택은 지금처럼 로그인 화면을 씁니다.
 */
export function isNoLogin(session: SessionResponse | null | undefined): boolean {
  return session?.noLogin === true;
}

/** 로그인 없이 운영자로 연 로컬 사용자인가 — 세션(쿠키)이 없어 로그아웃·기기 목록을 보이지 않습니다. */
export function isLocalOwner(user: SessionUser | null | undefined): boolean {
  return user?.local === true;
}

/** 로그인 없이 연 로컬 운영자를 셸 계정 영역·내 계정에 적는 이름. */
export const LOCAL_NO_LOGIN = "로컬 · 로그인 없음";

/** 셸 계정 영역에 적을 역할·등급 이름. */
export function roleLabel(user: SessionUser | null | undefined): string {
  if (!user) return "";
  if (isDemo(user)) return "데모 열람";
  if (user.role === "OWNER") return "운영자";
  return user.tier === "PRO" ? "유료 회원" : "무료 회원";
}
