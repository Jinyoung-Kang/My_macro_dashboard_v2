/**
 * 시험용 next/navigation — 정보 검색 화면이 쓰는 useSearchParams를 Next 라우터처럼 흉내 냅니다.
 *
 * Next(앱 라우터)는 window.history.pushState·replaceState를 라우터에 이어 useSearchParams를 바꾸고, 뒤로 가기(popstate)도 따라갑니다.
 * 여기서는 jsdom의 history 두 함수를 감싸 부를 때마다 구독자에게 알리고, useSearchParams가 window.location.search를 읽게 합니다.
 * `vi.mock("next/navigation", () => import("./fakeNavigation"))`로 씁니다.
 */
import { useMemo, useSyncExternalStore } from "react";
import { vi } from "vitest";

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

const history = window.history as History & { __searchFake?: boolean };
if (!history.__searchFake) {
  const push = history.pushState.bind(history);
  const replace = history.replaceState.bind(history);
  history.pushState = (...args: Parameters<History["pushState"]>) => {
    push(...args);
    notify();
  };
  history.replaceState = (...args: Parameters<History["replaceState"]>) => {
    replace(...args);
    notify();
  };
  history.__searchFake = true;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function useSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(subscribe, () => window.location.search, () => "");
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function usePathname(): string {
  return window.location.pathname;
}

export const router = { push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() };

export function useRouter() {
  return router;
}

/** 시험 사이에 주소를 되돌립니다(구독자에게도 알림). */
export function setLocation(path: string) {
  window.history.replaceState(null, "", path);
}
