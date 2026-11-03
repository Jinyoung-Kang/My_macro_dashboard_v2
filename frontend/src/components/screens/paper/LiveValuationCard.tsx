"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LiveIntervalSelect } from "@/components/LiveIntervalSelect";
import { type Column, DataTable } from "@/components/patterns";
import { Banner, Button, Card } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useLivePrices } from "@/hooks/useLivePrices";
import { useLiveSeconds } from "@/hooks/useLiveSeconds";
import { useTickerNames } from "@/hooks/useTickerNames";
import { useShownOnce } from "@/hooks/useShownOnce";
import { useVisibleWake } from "@/hooks/useVisibleWake";
import { endpoints } from "@/lib/endpoints";
import { deltaColor, EMPTY, formatKst } from "@/lib/format";
import { liveKey, liveSecondsText, serverRefreshMinutes, tradedAtText } from "@/lib/livePrices";
import type { PaperMarketCode } from "@/lib/paperMarket";
import {
  LIVE_FOLLOW_UP_MS,
  type LivePositionView,
  livePositionsFor,
  liveQuotesWarning,
  realtimeBookNav,
  type RealtimeNav,
  liveIntervalNote,
  liveRefreshMs,
  liveRevision,
  liveSessionView,
  msUntilNextOpen,
} from "@/lib/paperLive";
import type { PaperLiveResponse } from "@/lib/types";
import { TickerQuickView } from "./TickerQuickView";

/**
 * 장중 시세(추정) 카드 — 정규장 동안 고른 계좌의 종목 장중가가 고른 간격(실시간 시세 주기 — 기본 1시간, 5초~3시간, lib/livePrices)으로 움직이고,
 * 모든 값에 기준 시각을 붙입니다. 종목 가격은 서버가 그 주기마다 밀어 주는 실시간 시세(SSE, ADR 0024)이고, 종목을 누르면 팝업 창이 열립니다
 * (사용자 요청 2026-11-03 — 화면 안 팝업 창, TickerQuickView). 계좌 숫자를 낳는 장중 저장본은 1분보다 짧게 다시 읽지 않습니다(서버 하한). 장 상태·간격
 * 선택·'지금 새로 읽기'·출처·받지 못한 종목도 여기에 둡니다. 계좌 숫자(순자산·수익률)는 이 카드에서 빼고 개요의 지금 값이 같은 장중 저장본으로
 * 맡습니다(명세 2026-10-31 §4) — 계좌 고르기도 계좌 행 한 곳입니다(`bookCode`).
 *
 * 표시 전용입니다. 장부(체결·순자산 줄·통계·결정)는 이 값을 쓰지 않습니다(서버 PaperLiveService). 다시 읽기 규칙은 lib/paperLive —
 * 정규장에만 간격대로, 서버가 새 시세를 요청했으면 20초 뒤 한 번만 더, 장 밖에서는 멈추고 다음 개장에 한 번 깨어납니다. 탭을 숨기면 간격
 * 읽기는 useApi가 멈추고, '한 번 더'·'다음 개장' 깨우기는 탭이 다시 보일 때로 미룹니다(useVisibleWake — 보지 않는 동안 시세를 받지 않음,
 * QA-154). 미룬 '한 번 더'의 탭 복귀 읽기는 보통 읽기라(간격이 있으면 useApi, 끄기면 카드 훅), 응답이 새 수집을 요청했으면 그 뒤 20초에 한 번 더
 * 읽습니다(QA-157·159). 숨긴 탭으로 열렸으면 첫 읽기도 처음 보일 때까지 미룹니다(useShownOnce, QA-156).
 */
export function LiveValuationCard({
  market = "US",
  bookCode = null,
  onUpdated,
  onRealtime,
}: {
  market?: PaperMarketCode;
  /** 종목 표를 그릴 계좌(개요에서 고른 계좌). 없거나 응답에 없으면 첫 계좌. 바뀌어도 다시 읽지 않습니다(같은 응답의 다른 계좌). */
  bookCode?: string | null;
  /**
   * 새 장중 값(판 — lib/paperLive `liveRevision` — 이 바뀐 응답)을 받으면 부릅니다. 개요가 지금 값을 다시 읽게 하는 자리이고, 첫 응답은 기준으로만
   * 기억합니다(개요는 이미 그 저장본을 읽었음). 개요를 다시 읽어도 이 카드는 /live를 다시 부르지 않습니다.
   */
  onUpdated?: () => void;
  /**
   * 고른 계좌의 순자산을 실시간 시세로 다시 셀 때마다 부릅니다(사용자 결정 2026-11-03 — 개요 히어로의 '계좌 순자산'이 고른 주기로 움직임, lib/paperLive
   * realtimeBookNav). 실시간 가격이 없으면 null.
   */
  onRealtime?: (nav: RealtimeNav | null) => void;
}) {
  const [seconds] = useLiveSeconds();
  // 장중 저장본(계좌의 지금 값)은 1분보다 짧게 다시 읽지 않습니다(서버 MAX_AGE_LIVE) — 종목 가격만 고른 주기 그대로(실시간 시세).
  const minutes = serverRefreshMinutes(seconds);
  const [refreshMs, setRefreshMs] = useState(0);
  // 숨긴 탭으로 열렸으면 처음 보일 때까지 읽지 않습니다(QA-156) — 첫 읽기도 정규장이면 수집을 깨웁니다.
  const shown = useShownOnce();
  const live = useApi<PaperLiveResponse>(shown ? endpoints.paper.market(market).live : null, refreshMs);
  const data = live.data;
  const { reload } = live;
  // 바로 앞 읽기가 '한 번 더 읽기'였으면 또 예약하지 않습니다(수집이 늦어도 20초마다 되풀이하지 않게). 이 표시는 한 번 더 읽기가 실제로 나갈 때만
  // 세웁니다 — 타이머를 걸 때 세우면, 숨긴 사이 미룬 한 번 더를 useApi의 탭 복귀 읽기에 넘겼을 때 그 복귀 읽기의 응답을 소모해 그 응답이 요청한 새
  // 수집을 다음 간격(기본 30분, 1·3시간이면 그만큼)까지 읽지 않았습니다(QA-157).
  const followingUp = useRef(false);
  const readFollowUp = useCallback(() => {
    followingUp.current = true;
    void reload();
  }, [reload]);
  // 타이머의 다시 읽기 — 숨긴 탭이면 다시 보일 때로 미룹니다(QA-154). reload를 바로 부르면 숨긴 탭에서도 /live가 나가 정규장이면 수집을 깨웠습니다.
  // 미룬 '한 번 더'의 탭 복귀 읽기는 보통 읽기입니다 — 정규장 간격이 있으면 useApi의 복귀 읽기가, 간격이 0(끄기)이면 훅이 reload로 읽습니다. 복귀가
  // 늦으면 그 읽기가 새 수집을 깨우므로 응답이 20초 뒤 한 번 더를 걸 수 있어야 합니다(QA-157 — 끄기 갈래는 QA-159).
  const deferredFollowUp = useVisibleWake(reload, refreshMs);
  const wakeFollowUp = useCallback(() => {
    if (document.visibilityState === "visible") readFollowUp();
    else deferredFollowUp();
  }, [readFollowUp, deferredFollowUp]);
  const wakeAtOpen = useVisibleWake(reload, refreshMs);
  // 처음 받은 장중 값의 판 — 그 뒤 판이 바뀔 때만 onUpdated를 부릅니다.
  const revision = liveRevision(data);
  const seenRevision = useRef<string | null>(null);

  useEffect(() => {
    setRefreshMs(liveRefreshMs(data, minutes));
  }, [data, minutes]);

  const names = useTickerNames();

  // 실시간 시세(SSE) — 정규장과 그 앞뒤(프리장·애프터장 — 사용자 요청 2026-11-03)에 고른 계좌의 종목만. 훅은 아래 이른 반환보다 먼저 불러야 합니다.
  const tickers = useMemo(
    () => (livePositionsFor(data, bookCode, market)?.positions ?? []).map((row) => liveKey(market, row.ticker)),
    [data, bookCode, market],
  );
  const phase = data?.session?.phase;
  const extended = phase === "PRE" || phase === "AFTER";
  const realtime = useLivePrices(tickers, seconds, Boolean(data?.available) && (phase === "REGULAR" || extended));
  // 히어로의 실시간 순자산 — 종목 표와 같은 계좌(고른 계좌, 없으면 첫 계좌). 실시간 시세 연결이 닫혀 다시 열기를 기다리는 동안은 받은 가격이 멈춘
  // 값이라 내지 않습니다(히어로는 서버 지금 값 — QA-183).
  const { disconnected } = realtime;
  useEffect(() => {
    if (!onRealtime) return;
    const books = data?.available ? data.books ?? [] : [];
    const book = books.find((entry) => entry.code === bookCode) ?? books[0] ?? null;
    onRealtime(disconnected ? null : realtimeBookNav(book, market, realtime.prices));
  }, [data, bookCode, market, realtime.prices, disconnected, onRealtime]);

  useEffect(() => {
    if (revision === null) return;
    const previous = seenRevision.current;
    seenRevision.current = revision;
    if (previous !== null && previous !== revision) onUpdated?.();
  }, [revision, onUpdated]);

  useEffect(() => {
    if (!data) return;
    if (followingUp.current) {
      followingUp.current = false;
      return;
    }
    if (!data.quotes?.refreshRequested) return;
    const timer = setTimeout(wakeFollowUp, LIVE_FOLLOW_UP_MS);
    return () => clearTimeout(timer);
  }, [data, wakeFollowUp]);

  // 한 번 더 읽기가 실패하면 data가 그대로라 위 효과가 돌지 않아 표시가 남았습니다 — 그러면 다음 응답(간격 읽기·'지금 새로 읽기')이 요청한 새 수집을
  // 한 번 더의 응답으로 소모했습니다(QA-162). 실패를 받으면 표시를 내립니다. 실패마다 새 값인 failedAt으로 봅니다 — refreshError(문구)로 보면 20초 안에
  // 다른 읽기가 같은 문구로 먼저 실패했을 때 한 번 더의 실패가 변화로 오지 않았습니다(QA-163).
  const { failedAt } = live;
  useEffect(() => {
    if (failedAt) followingUp.current = false;
  }, [failedAt]);

  useEffect(() => {
    const wait = msUntilNextOpen(data?.session, Date.now());
    if (wait === null || minutes === 0) return;
    const timer = setTimeout(wakeAtOpen, wait);
    return () => clearTimeout(timer);
  }, [data, minutes, wakeAtOpen]);

  if (live.error && !data) {
    return (
      <Card title="장중 시세 (추정)">
        <Banner tone="warn">장중 시세를 읽지 못했습니다 — {live.error}</Banner>
      </Card>
    );
  }
  if (!data?.available) return null;

  const session = liveSessionView(data.session, data.quotes);
  const holdings = livePositionsFor(data, bookCode, market, realtime.prices);
  const warning = session.live ? liveQuotesWarning(data.quotes, names) : null;
  const intervalNote = session.live ? liveIntervalNote(minutes, market) : null;
  const positionColumns: Column<LivePositionView>[] = [
    { key: "ticker", header: "종목", rowHeader: true, cell: (row) => <TickerQuickView market={market} code={row.ticker} />, className: "whitespace-nowrap font-semibold" },
    { key: "qty", header: "수량", align: "right", cell: (row) => <span className="tabular-nums">{row.qty}</span> },
    // 그 계좌의 평균 단가(보유 표의 평단 칸과 같은 값·같은 이름 — 사용자 요청 2026-11-03)
    {
      key: "avgCost",
      header: market === "KR" ? "평단(원)" : "평단(달러)",
      align: "right",
      cell: (row) => <span className="tabular-nums">{row.avgCost}</span>,
    },
    {
      key: "price",
      header: "가격",
      align: "right",
      cell: (row) => <span className={`tabular-nums ${row.realtime ? "text-bright" : ""}`} title={row.priceTitle ?? undefined}>{row.price}</span>,
    },
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
      title="장중 시세 (추정)"
      subtitle={`${session.label} — ${session.detail}`}
      // 계좌의 지금 값(개요 히어로·계좌 행의 장중 추정)은 서버가 이 카드가 받은 장중 저장본으로 평가한 값입니다(개요는 수집을 요청하지 않음).
      source={`표시 전용 — 장부(체결·순자산 줄·통계·결정)는 이 시세를 쓰지 않음 · 계좌의 지금 값(장중 추정)은 이 시세로 평가한 값 · 지금 ${formatKst(data.nowKst ?? null)}`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <LiveIntervalSelect label="새로고침" />
          <Button onClick={() => void reload()} disabled={live.loading}>
            {live.loading ? "읽는 중…" : "지금 새로 읽기"}
          </Button>
        </div>
      }
    >
      <p className="mb-3 text-xs text-muted">
        {session.live
          ? seconds === 0
            ? "자동 새로고침이 꺼져 있습니다 — '지금 새로 읽기'를 누를 때만 다시 읽습니다."
            : `정규장 동안 종목 가격은 ${liveSecondsText(seconds)}마다 서버가 보내 주고(실시간 시세), 계좌 숫자는 ${liveSecondsText(minutes * 60)}마다 다시 읽습니다(이 화면을 보는 동안만).`
          : extended && seconds > 0
            ? `장 밖에서는 계좌 숫자를 다시 읽지 않습니다 — 종목 가격은 프리장·애프터장이 열려 있으면 ${liveSecondsText(seconds)}마다 그 가격을 받습니다.`
            : "장 밖에서는 다시 읽지 않습니다 — 숫자는 아래 기준 시각의 값입니다."}
        {intervalNote && <span className="ml-1">{intervalNote}</span>}
        {(session.live || extended) && realtime.receivedAt !== null && (
          <span className="ml-1">· 실시간 시세 받은 시각 {tradedAtText(new Date(realtime.receivedAt).toISOString())} KST</span>
        )}
        {(session.live || extended) && realtime.error && <span className="ml-1 text-warn">· {realtime.error}</span>}
        {live.refreshError && <span className="ml-1 text-warn">· 새로 읽지 못함({live.refreshError})</span>}
      </p>
      {warning && <div className="mb-3"><Banner tone="warn">{warning}</Banner></div>}
      {holdings ? (
        <>
          <p className="mb-2 text-xs text-text-2">
            <strong className="text-text">{holdings.label}</strong> 보유 종목 — 계좌 행을 누르면 그 계좌로 바뀝니다
          </p>
          <DataTable
            columns={positionColumns}
            rows={holdings.positions}
            rowKey={(row) => row.ticker}
            caption={`${holdings.label} 보유 종목 장중가`}
            emptyText="보유 종목이 없습니다(현금뿐)."
            scrollHint="overflow"
          />
        </>
      ) : (
        <p className="text-sm text-muted">계좌가 없습니다.</p>
      )}
    </Card>
  );
}

function Delta({ text, value }: { text: string; value: number | null }) {
  return <span className={`tabular-nums ${text === EMPTY ? "text-muted" : deltaColor(value)}`}>{text}</span>;
}
