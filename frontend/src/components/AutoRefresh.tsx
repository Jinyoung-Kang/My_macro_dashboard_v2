"use client";

import { useEffect, useState } from "react";
import { inputClasses } from "@/components/ui";
import { formatKst } from "@/lib/format";

/**
 * 자동 갱신 간격 선택기.
 *
 * [무엇을 할 수 있고 무엇을 할 수 없나]
 * 이 선택기는 **화면이 백엔드를 다시 읽는 주기**를 정합니다. 페이지를 새로
 * 그리지 않고 숫자만 바뀝니다.
 *
 * 다만 값이 실제로 움직이는 속도는 수집 주기가 정합니다. 매크로 카드는 전부
 * Yahoo를 폴링해서 받아오고(21개 티커에 약 3초), 국채·VIX는 출처부터가 15분
 * 지연 시세입니다. 스트리밍 소스가 아니므로 **초 단위 실시간은 불가능**합니다.
 * 10초를 고르면 화면은 10초마다 다시 읽지만, 저장본이 갱신되는 하한은
 * 60초입니다(백엔드 Datasets.MAX_AGE_LIVE). 이 하한은 Yahoo 429 차단을 피하기
 * 위한 것입니다 — 실제로 막혀 화면이 빈 적이 있습니다.
 *
 * 그래서 목록에 '실시간'을 넣지 않았습니다. 지킬 수 없는 약속이기 때문입니다.
 */

/** 초 단위. 0은 끄기. */
export const REFRESH_OPTIONS = [
  { value: 0, label: "끄기" },
  { value: 10, label: "10초" },
  { value: 30, label: "30초" },
  { value: 60, label: "1분" },
  { value: 300, label: "5분" },
  { value: 600, label: "10분" },
  { value: 1800, label: "30분" },
] as const;

/** 이 값 이하를 고르면 백엔드에 live 모드로 요청합니다(저장본 갱신 하한 60초). */
export const LIVE_THRESHOLD_SECONDS = 60;

const STORAGE_KEY = "macro.autoRefreshSeconds";
const DEFAULT_SECONDS = 60;

/**
 * 고른 간격을 기억합니다.
 *
 * 브라우저를 닫았다 열어도 유지됩니다. localStorage를 못 쓰는 환경(시크릿 모드
 * 등)에서도 화면이 멀쩡히 뜨도록 읽기·쓰기를 모두 감쌉니다.
 */
function readStoredSeconds(): number {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const parsed = stored === null ? NaN : Number(stored);
    return REFRESH_OPTIONS.some((option) => option.value === parsed) ? parsed : DEFAULT_SECONDS;
  } catch {
    return DEFAULT_SECONDS;   // 저장된 값을 못 읽어도 기본값으로 동작합니다.
  }
}

export function useAutoRefreshSeconds(): [number, (seconds: number) => void] {
  // 첫 렌더부터 저장된 값을 씁니다. effect에서 뒤늦게 바꾸면 매크로 화면이 기본값(60초)으로
  // 먼저 `live=true` 수집을 한 번 쏘고 나서야 사용자가 고른 간격으로 다시 요청했습니다.
  // (dashboard) 화면은 서버에서 그리지 않으므로 localStorage를 초기값에 써도 됩니다.
  const [seconds, setSeconds] = useState(readStoredSeconds);

  const update = (next: number) => {
    setSeconds(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // 기억만 못 할 뿐, 이번 세션에서는 정상 동작합니다.
    }
  };

  return [seconds, update];
}

/**
 * 이 브라우저가 마지막으로 다시 읽은 시각 (한국 시간, 분 단위).
 *
 * 수집 시각이 아니라 "화면을 갱신한 시각"이라 항상 오늘입니다 — 날짜는 생략합니다.
 */
function formatClock(date: Date): string {
  return formatKst(date).slice(11);
}

export function AutoRefreshControl({
  seconds,
  onChange,
  loadedAt,
  loading,
}: {
  seconds: number;
  onChange: (seconds: number) => void;
  /** 마지막으로 응답을 받은 시각 (useApi의 loadedAt). */
  loadedAt?: Date | null;
  loading?: boolean;
}) {
  // 탭이 숨으면 자동 갱신이 멈춥니다(useApi). 화면에도 그 사실을 적습니다 —
  // 돌아왔을 때 "멈춰 있었네"를 알 수 있어야 합니다.
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const onChangeVisibility = () => setHidden(document.visibilityState !== "visible");
    onChangeVisibility();
    document.addEventListener("visibilitychange", onChangeVisibility);
    return () => document.removeEventListener("visibilitychange", onChangeVisibility);
  }, []);

  return (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-1.5 text-[11px] text-muted">
        <span className="whitespace-nowrap">자동 갱신</span>
        <select
          value={String(seconds)}
          onChange={(event) => onChange(Number(event.target.value))}
          className={inputClasses("sm")}
          aria-label="자동 갱신 간격"
        >
          {REFRESH_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <span className="text-[11px] tabular-nums text-muted">
        {seconds === 0 ? (
          "수동"
        ) : loading ? (
          <span className="text-accent">갱신 중…</span>
        ) : hidden ? (
          "다른 탭 — 멈춤"
        ) : loadedAt ? (
          `↻ ${formatClock(loadedAt)}`
        ) : (
          ""
        )}
      </span>
    </div>
  );
}
