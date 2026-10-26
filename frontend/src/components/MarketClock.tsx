"use client";

import { useEffect, useMemo, useState } from "react";
import { useApi } from "@/hooks/useApi";
import type { KrHolidaysResponse } from "@/lib/types";
import {
  krHolidayCoverage,
  krMarketHolidays,
  usMarketHolidays,
} from "@/lib/marketCalendar";
import { endpoints } from "@/lib/endpoints";

/**
 * 실시간 거래소 시계 + 장 상태 배지.
 *
 * 휴장 판정은 `lib/marketCalendar`가 맡습니다. 예전에는 브라우저가 공개
 * 공휴일 API를 호출했는데, 공휴일과 거래소 휴장일이 달라 잘못된 배지가
 * 떴습니다(그 이유는 marketCalendar에 적어 두었습니다).
 */

type MarketStatus = {
  text: string;
  className: string;
};

/**
 * 장 상태 배지 색 — 디자인 토큰만 씁니다(라이트·다크가 함께 바뀜). 배지 글자는 옅은 바탕(같은 색 10%) 위에서 두 테마 모두
 * 4.5:1 이상입니다(라이트 4.7~4.8, 다크 5.2~6.6, 애프터 잉크 15.9·11.7). 15% 바탕은 라이트에서 4.4:1로 모자랐고,
 * 예전 애프터마켓의 purple-300은 라이트 표면에서 1.8:1이었습니다. 상태는 글자(거래 중·프리마켓…)가 나르고 색은 보조입니다.
 */
const STATUS_STYLES: Record<string, string> = {
  trading: "bg-ok/10 text-ok border-ok/40",
  pre: "bg-warn/10 text-warn border-warn/40",
  post: "bg-accent/10 text-accent border-accent/40",
  closed: "bg-muted/10 text-muted border-muted/40",
};

function partsFor(timeZone: string, now: Date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value]),
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: String(parts.weekday),
  };
}

function statusFor(
  market: "KOSPI" | "NASDAQ",
  minutes: number,
  weekday: string,
  isHoliday: boolean,
): MarketStatus {
  if (weekday === "Sat" || weekday === "Sun") {
    return { text: "휴장 (주말)", className: STATUS_STYLES.closed };
  }
  if (isHoliday) {
    return { text: "휴장 (공휴일)", className: STATUS_STYLES.closed };
  }

  if (market === "KOSPI") {
    if (minutes >= 9 * 60 && minutes < 15 * 60 + 30) {
      return { text: "거래 중", className: STATUS_STYLES.trading };
    }
    if (minutes >= 8 * 60 + 30 && minutes < 9 * 60) {
      return { text: "프리마켓", className: STATUS_STYLES.pre };
    }
    if (minutes >= 15 * 60 + 30 && minutes <= 18 * 60) {
      return { text: "애프터마켓", className: STATUS_STYLES.post };
    }
    return { text: "장 마감", className: STATUS_STYLES.closed };
  }

  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) {
    return { text: "거래 중", className: STATUS_STYLES.trading };
  }
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) {
    return { text: "프리마켓", className: STATUS_STYLES.pre };
  }
  if (minutes >= 16 * 60 && minutes <= 20 * 60) {
    return { text: "애프터마켓", className: STATUS_STYLES.post };
  }
  return { text: "장 마감", className: STATUS_STYLES.closed };
}

export function MarketClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    // 서버 렌더 시각과 클라이언트 시각이 달라 하이드레이션 경고가 나는 것을
    // 막기 위해, 마운트 후에만 시각을 그립니다.
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 시각을 먼저 각 시장의 현지 날짜로 바꿉니다. 브라우저 로컬 연도를 쓰면
  // 12월 31일처럼 시장마다 해가 갈리는 날 엉뚱한 해의 휴장일을 보게 됩니다.
  const kst = now ? partsFor("Asia/Seoul", now) : null;
  const est = now ? partsFor("America/New_York", now) : null;

  // 휴장 판정은 계산과 표 조회라 네트워크 없이도 됩니다(공식 목록은 보탬일 뿐).
  // 해가 바뀔 때만 다시 만들면 되므로 연도를 키로 캐시합니다.
  const krYear = kst ? Number(kst.date.slice(0, 4)) : null;
  const usYear = est ? Number(est.date.slice(0, 4)) : null;
  // 공식 공휴일(천문연)을 백엔드에서 한 번 받아 둡니다. 실패해도 시계는 내장 표로
  // 동작합니다 — 응답이 없다고 "거래 중"을 멈추면 안 됩니다.
  const { data: official } = useApi<KrHolidaysResponse>(endpoints.publicData.krHolidays);
  const officialDays = useMemo(
    () => (krYear === null ? null : official?.years?.[String(krYear)]?.holidays.map((day) => day.date) ?? null),
    [official, krYear],
  );
  const krHolidays = useMemo(
    () => (krYear === null ? new Set<string>() : krMarketHolidays(krYear, officialDays)),
    [krYear, officialDays],
  );
  const usHolidays = useMemo(
    () => (usYear === null ? new Set<string>() : usMarketHolidays(usYear)),
    [usYear],
  );

  if (!now || !kst || !est) {
    return <div className="h-[46px] rounded-lg border border-border bg-surface" />;
  }

  const kstStatus = statusFor("KOSPI", kst.minutes, kst.weekday, krHolidays.has(kst.date));
  const estStatus = statusFor("NASDAQ", est.minutes, est.weekday, usHolidays.has(est.date));

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-4 py-2 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
      <ClockEntry
        flag="🇰🇷"
        label="한국 (KOSPI)"
        shortLabel="KOSPI"
        date={kst.date}
        time={kst.time}
        status={kstStatus}
        note={
          krYear !== null && krHolidayCoverage(krYear, officialDays) === "rules"
            ? `${krYear}년 공휴일 목록이 없어 양력 고정 휴일만 반영했습니다 (설날·추석·대체공휴일 제외). DATA_GO_KR_SERVICE_KEY를 설정하면 천문연 공식 목록을 씁니다`
            : undefined
        }
      />
      <ClockEntry
        flag="🗽"
        label="뉴욕 (NASDAQ)"
        shortLabel="NASDAQ"
        date={est.date}
        time={est.time}
        status={estStatus}
      />
    </div>
  );
}

/*
  좁은 화면에서는 한 줄에 다 들어가지 않습니다. 예전에는 그대로 접혀서
  "장 마 감"처럼 배지 글자가 세 줄로 쪼개졌습니다. 줄바꿈을 막고, 라벨만
  짧게 바꿉니다(날짜는 시장마다 다를 수 있어 그대로 둡니다).
*/
function ClockEntry({
  flag,
  label,
  shortLabel,
  date,
  time,
  status,
  note,
}: {
  flag: string;
  label: string;
  shortLabel: string;
  date: string;
  time: string;
  status: MarketStatus;
  /** 판정에 빠진 정보가 있을 때의 안내. 배지에 마우스를 올리면 보입니다. */
  note?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span>{flag}</span>
      <span className="whitespace-nowrap text-muted">
        <span className="sm:hidden">{shortLabel}</span>
        <span className="hidden sm:inline">{label}</span>
      </span>
      <span className="whitespace-nowrap font-mono tabular-nums text-bright">
        {date} {time}
      </span>
      <span
        className={`shrink-0 whitespace-nowrap rounded-sm border px-2 py-0.5 text-[11px] font-semibold ${status.className}`}
        title={note}
      >
        {status.text}
        {note && <span className="ml-1 font-normal opacity-70">ⓘ</span>}
      </span>
    </div>
  );
}
