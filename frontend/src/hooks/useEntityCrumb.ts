"use client";

import { useEffect, useSyncExternalStore } from "react";

/** 빵부스러기 마지막 칸에 넘기는 대상 이름 — 그 대상 상세 화면의 정규 주소(lib/detail stockHref 등)와 이름. */
export type EntityCrumb = { href: string; label: string };

/**
 * 상세 화면이 읽은 대상 이름(삼성전자·기관 이름·지표 이름)을 셸 상단바 빵부스러기에 넘기는 작은 저장소(작업대 P4 — P3 빵부스러기는 주소의
 * 식별자만 적음, lib/breadcrumbs 머리 주석). 셸과 화면은 서로를 가져오지 않고 이 모듈 하나를 같이 봅니다 — API를 더 부르지 않습니다.
 *
 * - 화면은 `useEntityCrumb(href, label)`로 넣습니다(이름을 아직 모르면 null — 넣지 않음). 화면이 사라질 때(다른 주소로 감) 저장된 것이 그 화면의
 *   주소일 때만 지웁니다 — 상세 → 상세로 옮길 때 새 화면이 먼저 넣었으면 앞 화면의 정리가 그것을 지우지 않습니다. React Strict Mode의 두 번 효과도
 *   같은 값으로 끝납니다(넣기 → 지우기 → 넣기).
 * - 셸은 `useEntityCrumbLabel()`로 읽고, lib/breadcrumbs가 지금 주소의 대상 칸과 주소가 같을 때만 그 칸 글을 바꿉니다(다른 주소의 이름이 남지 않음).
 * - 서버 렌더·첫 하이드레이션 값은 null(주소의 식별자 그대로)입니다.
 */

let current: EntityCrumb | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): EntityCrumb | null => current;
const getServerSnapshot = (): EntityCrumb | null => null;

/** 상세 화면 — 지금 대상의 정규 주소와 이름을 셸에 넘깁니다. 둘 중 하나라도 없으면 넘기지 않습니다. */
export function useEntityCrumb(href: string | null, label: string | null): void {
  useEffect(() => {
    if (!href || !label) return;
    current = { href, label };
    notify();
    return () => {
      if (current?.href === href) {
        current = null;
        notify();
      }
    };
  }, [href, label]);
}

/** 셸 — 상세 화면이 넘긴 대상 이름(없으면 null). */
export function useEntityCrumbLabel(): EntityCrumb | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** 시험용 — 저장소를 비웁니다. */
export function resetEntityCrumbForTest(): void {
  current = null;
  notify();
}
