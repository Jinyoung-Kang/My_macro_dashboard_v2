/**
 * 넓은 화면 상단바의 빵부스러기(메뉴 › 하위 화면 › 대상) — 주소만으로 계산하는 순수 함수(ADR 0004, 작업대 실행 명세 §5, ADR 0042 결정 5).
 * 메뉴 표는 lib/nav.ts 하나를 씁니다(셸의 다른 부분과 같은 표). API를 부르지 않습니다 — 대상 칸은 주소의 식별자(키·코드·CIK)이고, 상세 화면이 이미
 * 읽은 이름(삼성전자·기관 이름·지표 이름)을 넘기면(`entity` — hooks/useEntityCrumb, P4 대상 머리) 그 칸의 주소와 같을 때만 글을 그 이름으로 바꿉니다
 * (주소·링크 여부는 그대로, 다른 주소의 이름은 무시 — 앞 화면의 이름이 남지 않음).
 *
 * 칸 순서: 탭 → 하위 화면 → 대상(상세·모의매매 탭). 마지막 칸이 지금 화면입니다(셸이 링크 없이 aria-current="page"로 그림).
 * - 탭의 화면이 하나뿐이고 그것이 탭 첫 화면이면(홈·정보 검색) 하위 화면 칸을 생략합니다(같은 이름이 두 번 나오지 않게).
 * - 하위 화면에 묶음이 있으면(더보기의 '한국 시장') 그 앞에 묶음 이름 칸을 링크 없이 둡니다.
 * - 이 사용자에게 보이지 않는 탭·화면(lib/access visibleMenus — 회원이 주소로 연 /paper/us 등)은 링크 없이 글만 둡니다.
 * - 대상 칸은 형식이 맞을 때만(lib/detail parse 함수·모의매매 탭 주소 규칙) — 틀리면 그 앞 칸에서 끝납니다. 메뉴에 없는 경로(/login 등)는 빈 목록.
 * - 뒤 칸 어느 것과 주소가 같은 칸은 링크 없이 글만 둡니다(QA-549) — 탭 칸의 주소는 탭 첫 화면이라, 첫 화면이 하위 화면이기도 한 탭(/macro·/institutions·
 *   /paper/us·/info/overview)에서 지금 화면으로 가는 링크나 바로 뒤 칸과 같은 곳으로 가는 링크 둘이 생겼습니다. 더 구체적인 뒤 칸(미국·매크로 지표·
 *   13F 포트폴리오)이 링크로 남으므로 갈 수 있는 곳은 줄지 않습니다(나무 메뉴는 같은 경우에 aria-current — nav.ts tabCurrent).
 *
 * 셸은 모든 화면이 싣습니다. 그래서 모의매매 탭 이름은 lib/paper(PAPER_TABS)·lib/paperRoutes를 가져오지 않고 아래 작은 표로 둡니다 — 가져오면 모의매매 모듈
 * 묶음(압축 전 약 175KB)이 모든 화면의 첫 적재에 실렸습니다(webpack 빌드로 잼, /more 첫 적재 gzip 256 → 337KB). 표와 주소 규칙이 PAPER_TABS·
 * paperRouteFromPath와 같은지는 breadcrumbs.test가 대조합니다.
 */
import { activeItem, activeTab, visibleItems, visibleTabs, type NavTab } from "./nav";
import { indicatorHref, institutionHref, parseCik, parseIndicatorKey, parseStockRoute, stockHref } from "./detail";
import type { SessionUser } from "./types";

/** 빵부스러기 한 칸 — href가 null이면 링크 없이 글만(묶음 이름·보이지 않는 메뉴·주소가 따로 없는 칸·뒤 칸과 주소가 같은 칸). */
export type Crumb = { label: string; href: string | null };

/** 종목 상세의 중간 칸 이름 — 시장별(주소가 따로 없는 글 칸). */
const STOCK_SECTION: Record<"us" | "kr", string> = { us: "종목(미국)", kr: "종목(한국)" };

/** 지표 상세의 중간 칸 — 매크로 지표 화면(지표 카드가 있는 곳). */
const MACRO_HREF = "/macro";

/**
 * 모의매매 탭 주소 조각 → 이름과 그 탭이 있는 시장(lib/paper PAPER_TABS의 개요 밖 탭과 같음 — 시험이 대조). 'ISA 계좌'는 한국 화면에만 있습니다.
 */
export const PAPER_TAB_CRUMBS: Readonly<Record<string, { label: string; markets: readonly ("us" | "kr")[] }>> = {
  selection: { label: "기관 선정", markets: ["us", "kr"] },
  holdings: { label: "보유·체결", markets: ["us", "kr"] },
  decisions: { label: "결정 로그", markets: ["us", "kr"] },
  framework: { label: "프레임", markets: ["us", "kr"] },
  notes: { label: "메모", markets: ["us", "kr"] },
  settings: { label: "설정", markets: ["us", "kr"] },
  real: { label: "실제 계좌", markets: ["us", "kr"] },
  isa: { label: "ISA 계좌", markets: ["kr"] },
};

/** 모의매매 탭 주소 `/paper/<us|kr>/<조각>`(끝 '/' 하나 허용 — lib/paperRoutes paperRouteFromPath와 같은 규칙). 개요(뿌리 주소)는 탭 칸이 없습니다. */
const PAPER_TAB_PATH = /^\/paper\/(us|kr)\/([^/]+)\/?$/;

/** 주소의 마지막 조각 하나(`/markets/i/<조각>` 꼴) — 더 깊거나 비면 null. */
function singleSegment(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length).replace(/\/$/, "");
  return rest && !rest.includes("/") ? rest : null;
}

/** 대상 칸 계산 결과 — 칸들과, 마지막 칸이 상세 대상이면 그 정규 주소(보임과 상관없는 원래 주소 — 넘겨받은 이름과 대조). */
type DetailCrumbs = { crumbs: Crumb[]; entityHref: string | null };

const NO_DETAIL: DetailCrumbs = { crumbs: [], entityHref: null };

/** 대상 칸(상세 세 종류·모의매매 탭) — 탭·하위 화면 칸 뒤에 붙입니다. */
function detailCrumbs(pathname: string, tab: NavTab, visible: (href: string) => string | null): DetailCrumbs {
  if (tab.key === "paper") {
    const match = PAPER_TAB_PATH.exec(pathname);
    if (!match) return NO_DETAIL;
    const market = match[1] as "us" | "kr";
    const entry = Object.hasOwn(PAPER_TAB_CRUMBS, match[2]) ? PAPER_TAB_CRUMBS[match[2]] : undefined;
    if (!entry || !entry.markets.includes(market)) return NO_DETAIL;
    return { crumbs: [{ label: entry.label, href: visible(`/paper/${market}/${match[2]}`) }], entityHref: null };
  }
  if (tab.key === "markets") {
    const indicator = singleSegment(pathname, "/markets/i/");
    if (indicator !== null) {
      const key = parseIndicatorKey(indicator);
      const macro = tab.items.find((item) => item.href === MACRO_HREF);
      const href = key ? indicatorHref(key) : null;
      return {
        crumbs: [
          ...(macro ? [{ label: macro.label, href: visible(macro.href) }] : []),
          ...(key && href ? [{ label: key, href: visible(href) }] : []),
        ],
        entityHref: href,
      };
    }
    const stock = /^\/s\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
    if (stock) {
      const market = stock[1].trim().toLowerCase();
      if (market !== "us" && market !== "kr") return NO_DETAIL;
      const parsed = parseStockRoute(stock[1], stock[2]);
      const href = parsed ? stockHref(parsed.market, parsed.code) : null;
      return {
        crumbs: [{ label: STOCK_SECTION[market], href: null }, ...(parsed && href ? [{ label: parsed.code, href: visible(href) }] : [])],
        entityHref: href,
      };
    }
    return NO_DETAIL;
  }
  if (tab.key === "institutions") {
    const raw = singleSegment(pathname, "/institutions/");
    const cik = raw === null ? null : parseCik(raw);
    const href = cik ? institutionHref(cik) : null;
    return cik && href ? { crumbs: [{ label: `CIK ${cik}`, href: visible(href) }], entityHref: href } : NO_DETAIL;
  }
  return NO_DETAIL;
}

/** 넘겨받은 대상 이름 — 그 주소가 대상 칸의 정규 주소와 같고 이름이 비어 있지 않을 때만(앞뒤 공백 없이), 아니면 빈 글. 빵부스러기·탭 제목이 같이 씁니다. */
function matchedEntityName(detail: DetailCrumbs, entity: { href: string; label: string } | null | undefined): string {
  return entity && detail.entityHref !== null && entity.href === detail.entityHref ? entity.label.trim() : "";
}

/**
 * 지금 주소의 대상 칸 글 — 빵부스러기 마지막 칸과 같은 글(브라우저 탭 제목 앞에 붙임, QA-594 — app/(dashboard)/layout useDocumentTitle).
 * 상세 화면이 넘긴 이름의 주소가 대상 칸의 정규 주소와 같으면 그 이름, 아니면 대상 칸 글(지표 키·종목 코드·'CIK …'). 대상 칸이 없는 주소(모의매매 탭 —
 * 그 칸은 탭 이름이라 상세 대상이 아님, 목록 화면, 형식이 틀린 주소, 메뉴 밖)는 null입니다.
 * 예 — `/institutions/0001608046` + {href:'/institutions/0001608046', label:'국민연금 (National Pension Service)'} → 그 이름, 이름이 없으면 'CIK 0001608046'.
 */
export function entityCrumbLabel(pathname: string, entity?: { href: string; label: string } | null): string | null {
  const tab = activeTab(pathname);
  if (!tab) return null;
  const detail = detailCrumbs(pathname, tab, (href) => href);
  if (detail.entityHref === null) return null;
  return matchedEntityName(detail, entity) || (detail.crumbs.at(-1)?.label ?? null);
}

/**
 * 지금 주소의 빵부스러기. 예 — `/paper/us/holdings` → 모의매매 › 미국 › 보유·체결, `/markets/i/vix` → 시장 › 매크로 지표 › vix,
 * `/s/kr/005930` → 시장 › 종목(한국) › 005930, `/institutions/0001067983` → 기관 › 13F 포트폴리오 › CIK 0001067983, `/radar` → 더보기 › 한국 시장 › 수급 레이더.
 * `entity`(상세 화면이 넘긴 이름)의 주소가 대상 칸의 정규 주소와 같으면 그 칸 글만 이름으로 — `/s/kr/005930` + {href:'/s/kr/005930', label:'삼성전자'}
 * → 시장 › 종목(한국) › 삼성전자. 이름이 비었거나 주소가 다르면 무시합니다.
 * 첫 예의 '모의매매'(→ /paper/us)는 뒤 칸 '미국'과 주소가 같아 글 칸입니다.
 */
export function breadcrumbs(pathname: string, user: SessionUser | null | undefined, entity?: { href: string; label: string } | null): Crumb[] {
  const tab = activeTab(pathname);
  if (!tab) return [];
  const tabVisible = visibleTabs(user).includes(tab);
  const shown = new Set(tabVisible ? visibleItems(tab, user).map((item) => item.href) : []);
  // 보이지 않는 탭 아래의 주소는 모두 글 칸으로(하위 화면 링크는 그 화면이 보일 때만).
  const visible = (href: string): string | null => (tabVisible ? href : null);
  const crumbs: Crumb[] = [{ label: tab.label, href: tabVisible ? tab.href : null }];

  const item = activeItem(pathname);
  if (item && !(tab.items.length === 1 && item.href === tab.href)) {
    if (item.group) crumbs.push({ label: item.group, href: null });
    crumbs.push({ label: item.label, href: shown.has(item.href) ? item.href : null });
  }
  const detail = detailCrumbs(pathname, tab, visible);
  const named = matchedEntityName(detail, entity);
  const tail = named
    ? detail.crumbs.map((crumb, index) => (index === detail.crumbs.length - 1 ? { ...crumb, label: named } : crumb))
    : detail.crumbs;
  const all = [...crumbs, ...tail];
  // 뒤 칸 어느 것과 주소가 같은 칸은 글 칸으로 — 지금 화면으로 가는 링크·같은 곳으로 가는 링크 둘을 두지 않습니다(QA-549).
  return all.map((crumb, index) =>
    crumb.href !== null && all.slice(index + 1).some((later) => later.href === crumb.href) ? { ...crumb, href: null } : crumb,
  );
}
