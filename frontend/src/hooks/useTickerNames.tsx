"use client";

import { createContext, useContext } from "react";
import { tickerName } from "@/lib/paperMarket";

/**
 * 모의 매매 종목 이름 표(사용자 결정 2026-11-02 — 한국 화면에 종목 코드 대신 기업명). 한국 화면(`PaperScreen` market KR)이
 * `GET /api/paper/names?market=KR`로 한 번 읽어 내려 줍니다. 표 밖(미국 화면·화면만 그리는 테스트)에서는 빈 표라 코드가 그대로 보입니다.
 */
const TickerNamesContext = createContext<Readonly<Record<string, string>>>({});

export function TickerNamesProvider({
  names,
  children,
}: {
  names: Readonly<Record<string, string>> | null | undefined;
  children: React.ReactNode;
}) {
  return <TickerNamesContext.Provider value={names ?? {}}>{children}</TickerNamesContext.Provider>;
}

/** 이름 표 그대로 — lib 함수(구성 도넛 이름표 등)에 넘길 때. */
export function useTickerNames(): Readonly<Record<string, string>> {
  return useContext(TickerNamesContext);
}

/** 코드 → 표시 이름(모르면 코드 그대로 — {@link tickerName}). */
export function useTickerName(): (code: string | null | undefined) => string {
  const names = useContext(TickerNamesContext);
  return (code) => tickerName(code, names);
}
