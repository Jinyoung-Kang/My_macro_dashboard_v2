"use client";

import { useTickerName } from "@/hooks/useTickerNames";

/**
 * 종목 하나의 표시 이름 — 이름 표(한국 화면, `TickerNamesProvider`)에 있으면 기업명, 없으면 코드 그대로(사용자 결정 2026-11-02). 이름을 보일 때
 * 코드는 마우스를 올리면 보입니다(title).
 */
export function TickerName({ code }: { code: string | null | undefined }) {
  const name = useTickerName()(code);
  if (!code || name === code) {
    return <>{name}</>;
  }
  return <span title={code}>{name}</span>;
}
