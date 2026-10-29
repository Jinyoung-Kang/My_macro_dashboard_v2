"use client";

import { useEffect, useRef, useState } from "react";
import { type Column, DataTable } from "@/components/patterns";
import { Banner, Button, Card } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { deltaColor, EMPTY, formatKst } from "@/lib/format";
import type { PaperMarketCode } from "@/lib/paperMarket";
import {
  LIVE_FOLLOW_UP_MS,
  LIVE_REFRESH_OPTIONS,
  LIVE_REFRESH_STORAGE_KEY,
  type LiveBookView,
  liveBookView,
  type LivePositionView,
  liveQuotesWarning,
  liveRefreshMs,
  liveSessionView,
  msUntilNextOpen,
  normalizeLiveMinutes,
} from "@/lib/paperLive";
import type { PaperLiveResponse } from "@/lib/types";

/**
 * 🧪 장중 평가(추정) 카드 — 정규장 동안 계좌·종목 수익률이 고른 간격(기본 30분)으로 움직이고, 모든 값에 기준 시각을 붙입니다.
 *
 * 표시 전용입니다. 장부(체결·확정 순자산·통계·결정)는 이 값을 쓰지 않습니다(서버 PaperLiveService). 다시 읽기 규칙은 lib/paperLive —
 * 정규장에만 간격대로, 서버가 새 시세를 요청했으면 20초 뒤 한 번만 더, 장 밖에서는 멈추고 다음 개장에 한 번 깨어납니다. 탭을 숨기면
 * useApi가 멈춥니다(보지 않는 동안 시세를 받지 않음).
 */
export function LiveValuationCard({ market = "US" }: { market?: PaperMarketCode }) {
  const [minutes, setMinutes] = useLiveRefreshMinutes();
  const [refreshMs, setRefreshMs] = useState(0);
  const live = useApi<PaperLiveResponse>(endpoints.paper.market(market).live, refreshMs);
  const data = live.data;
  const { reload } = live;
  const [selected, setSelected] = useState<string | null>(null);
  // 바로 앞 읽기가 '한 번 더 읽기'였으면 또 예약하지 않습니다(수집이 늦어도 20초마다 되풀이하지 않게).
  const followingUp = useRef(false);

  useEffect(() => {
    setRefreshMs(liveRefreshMs(data, minutes));
  }, [data, minutes]);

  useEffect(() => {
    if (!data) return;
    if (followingUp.current) {
      followingUp.current = false;
      return;
    }
    if (!data.quotes?.refreshRequested) return;
    followingUp.current = true;
    const timer = setTimeout(() => void reload(), LIVE_FOLLOW_UP_MS);
    return () => clearTimeout(timer);
  }, [data, reload]);

  useEffect(() => {
    const wait = msUntilNextOpen(data?.session, Date.now());
    if (wait === null || minutes === 0) return;
    const timer = setTimeout(() => void reload(), wait);
    return () => clearTimeout(timer);
  }, [data, minutes, reload]);

  if (live.error && !data) {
    return (
      <Card title="장중 평가 (추정)">
        <Banner tone="warn">장중 평가를 읽지 못했습니다 — {live.error}</Banner>
      </Card>
    );
  }
  if (!data?.available) return null;

  const session = liveSessionView(data.session, data.quotes);
  const books = (data.books ?? []).map((book) => liveBookView(book, market));
  const open = books.find((book) => book.code === selected) ?? null;
  const warning = session.live ? liveQuotesWarning(data.quotes) : null;
  const columns: Column<LiveBookView>[] = [
    { key: "label", header: "계좌", rowHeader: true, cell: (row) => row.label, className: "whitespace-nowrap" },
    { key: "nav", header: "순자산", align: "right", cell: (row) => <span className="tabular-nums">{row.nav}</span> },
    { key: "return", header: "출발 대비", align: "right", cell: (row) => <Delta text={row.returnText} value={row.returnPct} /> },
    {
      key: "day",
      header: "오늘",
      align: "right",
      cell: (row) => (
        <span className="flex flex-col items-end">
          <Delta text={row.dayText} value={row.dayChangePct} />
          <span className="text-[10px] text-muted">{row.dayBase}</span>
        </span>
      ),
    },
    { key: "basis", header: "기준 시각", cell: (row) => <span className="whitespace-nowrap text-xs text-text-2">{row.basis}</span> },
    { key: "coverage", header: "장중 값", cell: (row) => <span className="whitespace-nowrap text-xs text-muted">{row.coverage}</span> },
  ];
  const positionColumns: Column<LivePositionView>[] = [
    { key: "ticker", header: "종목", rowHeader: true, cell: (row) => row.ticker, className: "whitespace-nowrap font-semibold" },
    { key: "qty", header: "수량", align: "right", cell: (row) => <span className="tabular-nums">{row.qty}</span> },
    { key: "price", header: "가격", align: "right", cell: (row) => <span className="tabular-nums">{row.price}</span> },
    {
      key: "at",
      header: "가격 기준",
      cell: (row) => <span className={`whitespace-nowrap text-xs ${row.live ? "text-text-2" : "text-muted"}`}>{row.priceAt}</span>,
    },
    { key: "day", header: "직전 종가 대비", align: "right", cell: (row) => <Delta text={row.dayText} value={row.dayChangePct} /> },
    { key: "return", header: "평균 단가 대비", align: "right", cell: (row) => <Delta text={row.returnText} value={row.returnPct} /> },
    { key: "weight", header: "비중", align: "right", cell: (row) => <span className="tabular-nums">{row.weight}</span> },
  ];

  return (
    <Card
      title="장중 평가 (추정)"
      subtitle={`${session.label} — ${session.detail}`}
      source={`표시 전용 — 장부(체결·확정 순자산·통계·결정)와 별개 · 지금 ${formatKst(data.nowKst ?? null)}`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            <span className="whitespace-nowrap">새로고침</span>
            <select
              value={String(minutes)}
              onChange={(event) => setMinutes(Number(event.target.value))}
              className="rounded-md border border-border bg-surface-hover px-2 py-1 text-xs text-body outline-hidden focus:border-accent"
              aria-label="장중 평가 새로고침 간격"
            >
              {LIVE_REFRESH_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <Button onClick={() => void reload()} disabled={live.loading}>
            {live.loading ? "읽는 중…" : "지금 새로 읽기"}
          </Button>
        </div>
      }
    >
      <p className="mb-3 text-xs text-muted">
        {session.live
          ? minutes === 0
            ? "자동 새로고침이 꺼져 있습니다 — '지금 새로 읽기'를 누를 때만 다시 읽습니다."
            : `정규장 동안 ${minutes}분마다 다시 읽습니다(이 화면을 보는 동안만).`
          : "장 밖에서는 다시 읽지 않습니다 — 숫자는 아래 기준 시각의 값입니다."}
        {live.refreshError && <span className="ml-1 text-warn">· 새로 읽지 못함({live.refreshError})</span>}
      </p>
      {warning && <div className="mb-3"><Banner tone="warn">{warning}</Banner></div>}
      <DataTable
        columns={columns}
        rows={books}
        rowKey={(row) => row.code}
        caption="계좌별 장중 평가"
        onRowClick={(row) => setSelected((current) => (current === row.code ? null : row.code))}
        emptyText="계좌가 없습니다."
        scrollHint="overflow"
      />
      {open && (
        <div className="mt-4">
          <p className="mb-2 text-xs text-text-2">
            <strong className="text-text">{open.label}</strong> 보유 종목 · 행을 다시 누르면 닫힙니다
          </p>
          <DataTable
            columns={positionColumns}
            rows={open.positions}
            rowKey={(row) => row.ticker}
            caption={`${open.label} 보유 종목 장중 평가`}
            emptyText="보유 종목이 없습니다."
            scrollHint="overflow"
          />
        </div>
      )}
    </Card>
  );
}

function Delta({ text, value }: { text: string; value: number | null }) {
  return <span className={`tabular-nums ${text === EMPTY ? "text-muted" : deltaColor(value)}`}>{text}</span>;
}

/** 고른 간격(분)을 이 브라우저에 기억합니다 — localStorage를 못 쓰면 이번 세션만. */
function useLiveRefreshMinutes(): [number, (minutes: number) => void] {
  const [minutes, setMinutes] = useState(() => {
    try {
      return normalizeLiveMinutes(window.localStorage.getItem(LIVE_REFRESH_STORAGE_KEY) ?? undefined);
    } catch {
      return normalizeLiveMinutes(undefined);
    }
  });
  const update = (next: number) => {
    setMinutes(next);
    try {
      window.localStorage.setItem(LIVE_REFRESH_STORAGE_KEY, String(next));
    } catch {
      // 기억만 못 할 뿐 이번 세션에서는 그대로 동작합니다
    }
  };
  return [minutes, update];
}
