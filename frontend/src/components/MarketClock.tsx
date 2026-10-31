"use client";

import { useEffect, useMemo, useState } from "react";
import { InfoIcon, StatusDot, type StatusTone } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import type { KrHolidaysResponse } from "@/lib/types";
import {
  krHolidayCoverage,
  krMarketHolidays,
  usMarketHolidays,
} from "@/lib/marketCalendar";
import { endpoints } from "@/lib/endpoints";

/**
 * 실시간 거래소 시계 — 상단바의 장 상태 칩 둘(KOSPI·NASDAQ).
 *
 * 휴장 판정은 `lib/marketCalendar`가 맡습니다. 예전에는 브라우저가 공개
 * 공휴일 API를 호출했는데, 공휴일과 거래소 휴장일이 달라 잘못된 배지가
 * 떴습니다(그 이유는 marketCalendar에 적어 두었습니다).
 *
 * 상단바가 한 번만 그립니다 — 좁은 화면의 두 번째 줄과 넓은 화면의 한 줄은 같은 인스턴스의 자리만 바뀝니다
 * (둘로 그리면 공휴일 요청·1초 시계·글이 두 번씩 생김).
 */

type MarketStatus = {
  text: string;
  tone: StatusTone;
};

/**
 * 장 상태 점의 톤 — 거래 중 ok, 프리·애프터마켓 warn, 장 마감·휴장 중립(text-3). 상태는 칩 글(거래 중·프리마켓…)이 나르고
 * 점은 보조입니다. 점은 테두리로 칠해 고대비(forced-colors) 모드에서도 남습니다(`StatusDot`).
 */
const STATUS_TONE: Record<"trading" | "pre" | "post" | "closed", StatusTone> = {
  trading: "ok",
  pre: "warn",
  post: "warn",
  closed: "neutral",
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
    return { text: "휴장 (주말)", tone: STATUS_TONE.closed };
  }
  if (isHoliday) {
    return { text: "휴장 (공휴일)", tone: STATUS_TONE.closed };
  }

  if (market === "KOSPI") {
    if (minutes >= 9 * 60 && minutes < 15 * 60 + 30) {
      return { text: "거래 중", tone: STATUS_TONE.trading };
    }
    if (minutes >= 8 * 60 + 30 && minutes < 9 * 60) {
      return { text: "프리마켓", tone: STATUS_TONE.pre };
    }
    if (minutes >= 15 * 60 + 30 && minutes <= 18 * 60) {
      return { text: "애프터마켓", tone: STATUS_TONE.post };
    }
    return { text: "장 마감", tone: STATUS_TONE.closed };
  }

  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) {
    return { text: "거래 중", tone: STATUS_TONE.trading };
  }
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) {
    return { text: "프리마켓", tone: STATUS_TONE.pre };
  }
  if (minutes >= 16 * 60 && minutes <= 20 * 60) {
    return { text: "애프터마켓", tone: STATUS_TONE.post };
  }
  return { text: "장 마감", tone: STATUS_TONE.closed };
}

/** 칩 모양 — 좁은 화면(상단바 둘째 줄)은 12px·높이 28px, 넓은 화면(상단바 한 줄 64px)은 13px·높이 32px. */
const CHIP =
  "inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-border px-2 text-xs text-text sm:gap-1.5 sm:px-2.5 lg:h-8 lg:px-3 lg:text-[13px]";

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
    // 마운트 전 자리 — 칩 둘의 높이를 미리 잡아 상단바가 흔들리지 않게 합니다.
    return (
      <div aria-hidden="true" className="flex items-center gap-2">
        <span className={`${CHIP} w-32 lg:w-36`} />
        <span className={`${CHIP} w-32 lg:w-36`} />
      </div>
    );
  }

  const kstStatus = statusFor("KOSPI", kst.minutes, kst.weekday, krHolidays.has(kst.date));
  const estStatus = statusFor("NASDAQ", est.minutes, est.weekday, usHolidays.has(est.date));

  return (
    <div className="flex min-w-0 items-center gap-2">
      <ClockChip
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
      <ClockChip
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
  장 상태 칩 — 상태 점 · 시장 이름 · 상태 · 시각. 줄을 바꾸지 않습니다(예전에는 접혀서 "장 마 감"처럼 배지 글자가 세 줄로
  쪼개졌습니다). 시각은 좁은 화면(둘째 줄)과 아주 넓은 화면(xl)에서 보이고, 그 사이(lg 한 줄 — 검색·벨과 나란히)에서는
  자리가 모자라 숨깁니다. 가장 좁은 화면(sm 미만)은 칩 둘이 한 줄에 들도록 가운뎃점과 초를 숨깁니다(390px에서 '휴장 (주말)' 둘).
  시장 전체 이름·현지 날짜·초까지의 시각·안내는 늘 title에 있습니다(날짜는 시장마다 다를 수 있음).
*/
function ClockChip({
  label,
  shortLabel,
  date,
  time,
  status,
  note,
}: {
  label: string;
  shortLabel: string;
  date: string;
  time: string;
  status: MarketStatus;
  /** 판정에 빠진 정보가 있을 때의 안내. 칩에 마우스를 올리면 보입니다(안내 아이콘이 있다는 표시). */
  note?: string;
}) {
  const title = [`${label} ${date} ${time}`, status.text, note].filter(Boolean).join(" — ");
  return (
    <span className={CHIP} title={title}>
      <StatusDot tone={status.tone} />
      <span className="font-medium">{shortLabel}</span>
      <span aria-hidden="true" className="hidden text-text-3 sm:inline">
        ·
      </span>
      <span>{status.text}</span>
      {note && <InfoIcon size={12} className="text-text-3" />}
      <span className="tabular-nums text-text-3 lg:hidden xl:inline">
        {time.slice(0, 5)}
        <span className="hidden sm:inline">{time.slice(5)}</span>
      </span>
    </span>
  );
}
