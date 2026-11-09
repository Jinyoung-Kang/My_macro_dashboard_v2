"use client";

import { useCallback, useMemo, useState } from "react";
import { LiveIntervalSelect } from "@/components/LiveIntervalSelect";
import { StatGrid, StatTile } from "@/components/patterns";
import { Banner, Button, Card, ErrorState, Freshness, Loading } from "@/components/ui";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useLivePrices } from "@/hooks/useLivePrices";
import { useLiveSeconds } from "@/hooks/useLiveSeconds";
import { endpoints } from "@/lib/endpoints";
import { deltaColor, formatKst, formatNumber, formatPercent, formatSigned } from "@/lib/format";
import {
  accountStateLabel,
  applyItemFor,
  BALANCE_CHANGED_TEXT,
  canConfirm,
  COST_NOTE,
  formatShares,
  formatWon,
  instructionWhenText,
  ISA_BANNER,
  ISA_SOURCE,
  isaBasisNote,
  isaBasisText,
  type IsaLiveQuote,
  type IsaPositionView,
  type IsaValuation,
  isaValuation,
  MIDDAY_GUIDE,
  NEGATIVE_CASH_TEXT,
  sessionLabel,
  sessionStatusLabel,
  sideLabel,
  STOP_GUIDE,
  symbolText,
  targetClock,
  toNumber,
  tradeGuide,
  unavailableText,
  unpricedText,
} from "@/lib/isa";
import { liveKey, liveSecondsText, liveShown } from "@/lib/livePrices";
import type { IsaApplyItem, IsaInstructionItem, IsaOkResponse, IsaResponse, IsaStopInstruction, IsaTrade } from "@/lib/types/isa";
import { IsaCommissionDialog, IsaTotalDialog } from "./IsaBalanceDialogs";
import { IsaPositionDialog, type IsaPositionTarget } from "./IsaPositionDialog";
import { IsaStartDialog } from "./IsaStartDialog";
import { IsaInstructionsTable, IsaPositionsTable, IsaRecentInstructionsTable, IsaStopInstructionsTable, IsaTradesTable } from "./IsaTables";
import { postApply, postDeletePosition, postSkipInstruction, postUndoTrade, sendIsa } from "./isaRequests";

/** 다시 읽는 주기 — 잔고는 밤 결정·사용자 고침 때만 바뀝니다(개요와 같은 1분). */
const POLL_MS = 60_000;

/**
 * ISA 계좌 칸(ADR 0029·0034) — 모의매매(한국)의 'ISA 계좌' 탭. 연결되지 않은 다른 증권사 계좌를 한국 규칙 계좌 메커니즘으로 운용합니다: 이 화면은 잔고와 '다음에 무엇을 몇 주'를
 * 보이고, 사용자가 그 지시(화면·텔레그램)를 보고 직접 매매한 뒤 '확인'을 누릅니다. 주문 기능은 없습니다.
 *
 * <p>GET /api/manual/isa 하나를 1분마다 읽습니다(모의 개요와 따로 — 개요가 실패해도 그립니다). 시작 전이면 '시작' 창(총 잔고 + 보유), 시작 뒤면 요약(총 평가액·현금·매입 금액 합·
 * 평가손익·누적 수수료·세금·수수료율) → 다음 매매 지시(줄마다 확인·건너뜀, 전부 확인) → 장중 스탑 지시 → 잔고(첫 열 고치기·지우기, 행 추가) → 매매 내역(되돌리기) 순입니다.
 * 쓰기는 isaRequests의 apiPost(endpoints.isa.*)뿐이고, 결과가 나오면 다시 읽습니다. 서버 오류는 코드별 문구(lib/isa)로 보입니다.
 *
 * <p>평가: 탭 머리의 주기 상자로 고른 주기마다 보유 ∪ 지시 ∪ 스탑 지시 종목의 실시간 가격(hooks/useLivePrices — ADR 0024 SSE, 표시 전용)을 받아 평가액·손익·비중을 화면에서 다시 셉니다
 * (lib/isa isaValuation — 못 받은 종목은 서버가 준 직전 종가, 표에 '직전 종가'). '확인'은 그 종목의 화면 가격을 본문에 실어 보냅니다(끊겼거나 못 받았으면 생략 — 서버 직전 종가).
 *
 * <p>이 모듈을 밖에서 가져오는 곳은 PaperScreen 하나입니다(경계 시험 __tests__/isaBoundary.test.ts). 미국 화면에는 이 탭이 없습니다.
 */
export function IsaSection() {
  const { data, loading, error, refreshError, reload } = useApi<IsaResponse>(endpoints.isa.account, POLL_MS);
  const reloadNow = useCallback(() => void reload(), [reload]);
  const [startOpen, setStartOpen] = useState(false);
  const [totalOpen, setTotalOpen] = useState(false);
  const [commissionOpen, setCommissionOpen] = useState(false);
  const [positionTarget, setPositionTarget] = useState<IsaPositionTarget | null>(null);
  const [deleteRow, setDeleteRow] = useState<IsaPositionView | null>(null);
  const [skipItem, setSkipItem] = useState<IsaInstructionItem | null>(null);
  const [undoRow, setUndoRow] = useState<IsaTrade | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const send = useCallback((request: () => Promise<IsaOkResponse>) => sendIsa(request, reloadNow), [reloadNow]);
  const action = useAsyncAction(send, "요청을 처리하지 못했습니다.");

  const available = data?.available === true;
  const started = available && data?.started === true;

  // 실시간 평가 — 보유 ∪ 지시 ∪ 스탑 지시 종목의 가격을 고른 주기마다 받아 평가액·손익·비중을 다시 셉니다(표시 전용, 지시는 직전 종가).
  const [liveSeconds] = useLiveSeconds();
  const positions = started ? data?.positions : null;
  const liveSymbols = useMemo(() => {
    const symbols = new Set<string>();
    (positions ?? []).forEach((row) => symbols.add(row.symbol));
    (started ? (data?.instructions?.items ?? []) : []).filter(canConfirm).forEach((item) => symbols.add(item.symbol));
    (started ? (data?.stopInstructions ?? []) : []).filter(canConfirm).forEach((item) => symbols.add(item.symbol));
    return [...symbols].sort();
  }, [positions, started, data?.instructions?.items, data?.stopInstructions]);
  const liveItems = useMemo(() => liveSymbols.map((symbol) => liveKey("KR", symbol)), [liveSymbols]);
  const realtime = useLivePrices(liveItems, liveSeconds, started);
  const quotes = useMemo(() => {
    const out: Record<string, IsaLiveQuote> = {};
    // 멈춘 값은 실시간으로 쓰지 않습니다(useLivePrices 계약 — QA-183·184): 연결이 끊기면 서버 값(직전 종가), 뒤 응답에서 빠진 종목은 직전 종가.
    for (const symbol of realtime.disconnected ? [] : liveSymbols) {
      const key = liveKey("KR", symbol);
      if (realtime.missing.includes(key)) continue;
      const price = Object.hasOwn(realtime.prices, key) ? realtime.prices[key] : null;
      if (!price) continue;
      const shown = liveShown(price);
      const receivedAt = realtime.receivedAtByKey[key];
      out[symbol] = { price: shown.price, at: shown.tradedAt ?? (typeof receivedAt === "number" ? new Date(receivedAt).toISOString() : null) };
    }
    return out;
  }, [liveSymbols, realtime.prices, realtime.receivedAtByKey, realtime.missing, realtime.disconnected]);
  const valuation = useMemo(() => isaValuation(positions, started ? data?.summary : null, quotes), [positions, started, data?.summary, quotes]);
  const positionPrices = useMemo(() => {
    const out: Record<string, number> = {};
    (positions ?? []).forEach((row) => {
      if (Object.hasOwn(quotes, row.symbol)) out[row.symbol] = quotes[row.symbol].price;
    });
    return out;
  }, [positions, quotes]);

  const applyItems = async (items: readonly IsaApplyItem[], count: number) => {
    setNotice(null);
    let reply: IsaOkResponse = { ok: true };
    const ok = await action.run(async () => {
      reply = await postApply({ items: [...items] });
      return reply;
    });
    if (ok) {
      const skipped = reply.skipped ?? 0;
      setNotice(`확인 ${reply.count ?? count}건을 잔고에 반영했습니다.${skipped > 0 ? ` 팔 보유가 없어 ${skipped}건은 닫았습니다.` : ""} 체결가가 다르면 잔고에서 가격을 고치세요.`);
    }
    reloadNow();
  };

  const confirmInstructions = (items: readonly IsaInstructionItem[]) =>
    void applyItems(items.map((item) => applyItemFor({ instructionId: item.id }, item.symbol, quotes)), items.length);
  const confirmStops = (rows: readonly IsaStopInstruction[]) =>
    void applyItems(rows.map((row) => applyItemFor({ stopInstructionId: row.id }, row.symbol, quotes)), rows.length);

  const confirmSkip = async () => {
    const item = skipItem;
    if (!item) return;
    setNotice(null);
    const ok = await action.run(() => postSkipInstruction(item.id));
    setSkipItem(null);
    if (ok) setNotice("지시를 건너뜀으로 두었습니다 — 잔고에 쓰지 않습니다.");
    reloadNow();
  };

  const confirmDelete = async () => {
    const row = deleteRow;
    if (!row) return;
    setNotice(null);
    const ok = await action.run(() => postDeletePosition(row.symbol));
    setDeleteRow(null);
    if (ok) setNotice("잔고 행을 지웠습니다 — 다음 지시는 지운 뒤의 잔고로 계산합니다.");
    reloadNow();
  };

  const confirmUndo = async () => {
    const row = undoRow;
    if (!row) return;
    setNotice(null);
    const ok = await action.run(() => postUndoTrade(row.id));
    setUndoRow(null);
    if (ok) setNotice("확인을 되돌렸습니다 — 잔고를 되돌리고 지시는 다시 미확인(그 세션 마감이 지났으면 닫힘)입니다.");
    reloadNow();
  };

  return (
    <div role="region" aria-label="ISA 계좌" className="flex flex-col gap-6">
      <Banner tone="info">{ISA_BANNER}</Banner>
      {started && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="text-xs tabular-nums text-text-2">
            <p>
              기준 시각 <strong className="font-semibold text-bright">{isaBasisText(valuation)}</strong>
            </p>
            <p className="mt-0.5 text-text-3">{isaBasisNote(valuation)}</p>
            {realtime.error && <p className="mt-0.5 text-warn">{realtime.error}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <LiveIntervalSelect />
            <span className="text-xs text-text-3">
              {liveSeconds === 0 ? "끄기 — 탭을 열 때 한 번 받음" : `${liveSecondsText(liveSeconds)}마다 받음(장이 닫혀 있으면 5분 이상 간격)`}
            </span>
          </div>
        </div>
      )}
      {loading && !data && <Loading label="ISA 계좌 잔고를 읽는 중…" />}
      {error && !data && <ErrorState message={`ISA 계좌 잔고를 읽지 못했습니다 — ${error}`} onRetry={reloadNow} />}
      {data && !available && <UnavailableNotice message={data.message ?? null} notes={data.notes ?? null} />}
      {notice && (
        <div role="status">
          <Banner tone="ok">{notice}</Banner>
        </div>
      )}
      {action.error && (
        <div role="alert">
          <Banner tone="danger">{action.error}</Banner>
        </div>
      )}

      {available && !started && (
        <Card title="ISA 계좌 — 시작 전" source={ISA_SOURCE} actions={<Freshness refreshError={refreshError} />}>
          <div className="flex flex-col gap-3 text-sm text-text-2">
            <p>
              증권사 앱의 오늘 총평가금액과 들고 있는 종목을 적으면 시작됩니다. 그 뒤 한국 규칙 계좌의 밤 결정(22:30)마다 다음 세션의 매매 지시를 만들어 이 화면과 텔레그램(08:00)으로 알립니다.
              시작은 한 번만 됩니다.
            </p>
            <div>
              <Button variant="primary" onClick={() => setStartOpen(true)}>
                시작
              </Button>
            </div>
          </div>
        </Card>
      )}

      {started && data && (
        <StartedBody
          data={data}
          valuation={valuation}
          refreshError={refreshError}
          busy={action.busy}
          onConfirm={confirmInstructions}
          onConfirmStops={confirmStops}
          onSkip={(item) => {
            setNotice(null);
            setSkipItem(item);
          }}
          onAddPosition={() => {
            setNotice(null);
            setPositionTarget({ mode: "add" });
          }}
          onEditPosition={(row) => {
            setNotice(null);
            setPositionTarget({ mode: "edit", row });
          }}
          onDeletePosition={(row) => {
            setNotice(null);
            setDeleteRow(row);
          }}
          onUndo={(row) => {
            setNotice(null);
            setUndoRow(row);
          }}
          onOpenTotal={() => {
            setNotice(null);
            setTotalOpen(true);
          }}
          onOpenCommission={() => {
            setNotice(null);
            setCommissionOpen(true);
          }}
        />
      )}

      <IsaStartDialog
        open={startOpen}
        onClose={() => setStartOpen(false)}
        onReload={reloadNow}
        onDone={(count, notes) => {
          setStartOpen(false);
          setNotice(`시작했습니다 — 보유 ${count}종목과 현금을 넣었습니다. 첫 지시는 한국 규칙 계좌의 다음 밤 결정(22:30) 뒤에 만듭니다.${notes.length > 0 ? ` ${notes.join(" ")}` : ""}`);
          reloadNow();
        }}
      />
      <IsaTotalDialog
        open={totalOpen}
        prices={positionPrices}
        onClose={() => setTotalOpen(false)}
        onReload={reloadNow}
        onDone={(notes) => {
          setTotalOpen(false);
          setNotice(`현금을 다시 셌습니다.${notes.length > 0 ? ` ${notes.join(" ")}` : ""}`);
          reloadNow();
        }}
      />
      <IsaCommissionDialog
        open={commissionOpen}
        current={toNumber(data?.summary?.commissionPct)}
        onClose={() => setCommissionOpen(false)}
        onReload={reloadNow}
        onDone={() => {
          setCommissionOpen(false);
          setNotice("수수료율을 고쳤습니다 — 다음 확인부터 이 요율로 셉니다.");
          reloadNow();
        }}
      />
      <IsaPositionDialog
        target={positionTarget}
        onClose={() => setPositionTarget(null)}
        onReload={reloadNow}
        onDone={() => {
          setPositionTarget(null);
          setNotice("잔고를 고쳤습니다 — 다음 지시는 고친 잔고로 계산합니다.");
          reloadNow();
        }}
      />
      <ConfirmDialog
        open={deleteRow !== null}
        onOpenChange={(open) => {
          if (!open && !action.busy) setDeleteRow(null);
        }}
        title="잔고 행 지우기"
        description={deleteRow ? `${symbolText(deleteRow.symbol, deleteRow.name)} 행을 지웁니다(현금은 바뀌지 않음). 되돌릴 수 없고, 다음 지시는 지운 뒤의 잔고로 계산합니다.` : undefined}
        confirmLabel="지우기"
        tone="danger"
        busy={action.busy}
        onConfirm={() => void confirmDelete()}
      />
      <ConfirmDialog
        open={skipItem !== null}
        onOpenChange={(open) => {
          if (!open && !action.busy) setSkipItem(null);
        }}
        title="지시 건너뜀"
        description={
          skipItem
            ? `${instructionWhenText(skipItem)}${sideLabel(skipItem.side)} ${symbolText(skipItem.symbol, skipItem.name)} ${formatShares(skipItem.quantity)}주 지시를 건너뜀으로 둡니다 — 잔고에 쓰지 않습니다(매매하지 않았을 때). 되돌릴 수 없습니다.`
            : undefined
        }
        confirmLabel="건너뜀"
        busy={action.busy}
        onConfirm={() => void confirmSkip()}
      />
      <ConfirmDialog
        open={undoRow !== null}
        onOpenChange={(open) => {
          if (!open && !action.busy) setUndoRow(null);
        }}
        title="확인 되돌리기"
        description={undoRow ? `${sideLabel(undoRow.side)} ${symbolText(undoRow.symbol, undoRow.name)} ${formatShares(undoRow.quantity)}주 확인을 되돌립니다 — 잔고를 원래대로 돌리고, 지시는 다시 미확인(그 세션 마감이 지났으면 닫힘)입니다.` : undefined}
        confirmLabel="되돌리기"
        busy={action.busy}
        onConfirm={() => void confirmUndo()}
      />
    </div>
  );
}

function StartedBody({
  data,
  valuation,
  refreshError,
  busy,
  onConfirm,
  onConfirmStops,
  onSkip,
  onAddPosition,
  onEditPosition,
  onDeletePosition,
  onUndo,
  onOpenTotal,
  onOpenCommission,
}: {
  data: IsaResponse;
  /** 요약·잔고의 평가 — 실시간 가격을 받았으면 그것으로 다시 센 값, 아니면 서버 값 그대로(lib/isa isaValuation). */
  valuation: IsaValuation;
  refreshError: string | null;
  busy: boolean;
  onConfirm: (items: readonly IsaInstructionItem[]) => void;
  onConfirmStops: (rows: readonly IsaStopInstruction[]) => void;
  onSkip: (item: IsaInstructionItem) => void;
  onAddPosition: () => void;
  onEditPosition: (row: IsaPositionView) => void;
  onDeletePosition: (row: IsaPositionView) => void;
  onUndo: (row: IsaTrade) => void;
  onOpenTotal: () => void;
  onOpenCommission: () => void;
}) {
  const account = data.account ?? null;
  const summary = data.summary ?? null;
  const profit = valuation.profitLoss;
  const unpriced = unpricedText(valuation.unpriced);
  const instructions = data.instructions ?? null;
  const recent = data.recentInstructions ?? [];
  const stops = data.stopInstructions ?? [];
  const [recentOpen, setRecentOpen] = useState(false);
  const timedAt = targetClock(instructions?.targetAt);
  const timed = timedAt !== null;
  const instructionsTitle = timed ? "다음 매매 지시" : "다음 시가 매매 지시";
  const confirmable = (instructions?.items ?? []).filter(canConfirm);
  const confirmableStops = stops.filter(canConfirm);
  const notes = cleanNotes(data.notes);
  const commission = toNumber(summary?.commissionPct);

  return (
    <>
      <Card
        title={account?.label || "ISA 계좌"}
        subtitle={`따라 하는 책: ${account?.sourceLabel || account?.sourceBook || "규칙 계좌"} · ${accountStateLabel(account?.state)} · 시작 ${formatKst(account?.startedAt)}`}
        source={ISA_SOURCE}
        actions={<Freshness refreshError={refreshError} />}
      >
        <div className="flex flex-col gap-3">
          <StatGrid cols={4}>
            <StatTile
              label="총 평가액"
              value={valuation.totalAsset}
              format={(value) => formatNumber(value, 0)}
              unit="원"
              note={`보유 평가 ${formatWon(valuation.marketValue)} + 현금 ${formatWon(valuation.cash)}`}
            />
            <StatTile label="현금" value={valuation.cash} format={(value) => formatNumber(value, 0)} unit="원" />
            <StatTile label="매입 금액 합" value={valuation.purchaseTotal} format={(value) => formatNumber(value, 0)} unit="원" />
            <StatTile
              label="평가손익"
              value={profit}
              format={(value) => formatSigned(value, 0)}
              unit="원"
              valueClassName={deltaColor(profit, 0)}
              note={`매입 금액 대비 ${formatPercent(valuation.profitLossPct)}(대시보드 계산)`}
            />
            <StatTile label="누적 수수료" value={toNumber(summary?.feesPaid)} format={(value) => formatNumber(value, 0)} unit="원" />
            <StatTile label="누적 세금" value={toNumber(summary?.taxesPaid)} format={(value) => formatNumber(value, 0)} unit="원" />
            <StatTile label="수수료율" value={commission} format={(value) => formatNumber(value, 3)} unit="%" note="매수·매도 각각" />
          </StatGrid>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={onOpenCommission} disabled={busy}>
              수수료율 고치기
            </Button>
            <Button size="sm" onClick={onOpenTotal} disabled={busy}>
              총 잔고 다시 맞추기
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-text-3">{COST_NOTE}</p>
          {valuation.cash !== null && valuation.cash < 0 && <Banner tone="warn">{NEGATIVE_CASH_TEXT}</Banner>}
          {unpriced && <Banner tone="warn">가격을 몰라 평가에서 뺀 종목: {unpriced} — 평가액·손익·비중에 들어가지 않았습니다.</Banner>}
          {notes.length > 0 && <NoteList notes={notes} />}
        </div>
      </Card>

      <Card
        title={instructionsTitle}
        subtitle={
          instructions?.session
            ? `${sessionLabel(instructions.session)} ${timed ? `${timedAt} 이후 시장가` : "시가"} · ${sessionStatusLabel(instructions.status)}`
            : "아직 다음 세션의 지시가 없습니다"
        }
      >
        <div className="flex flex-col gap-3">
          {!instructions && <p className="text-sm text-text-2">한국 규칙 계좌의 밤 결정(22:30)이 끝나면 10분 안에 다음 세션의 지시(시가 또는 개장 10분 뒤)를 만듭니다.</p>}
          {instructions?.ledgerChanged === true && <Banner tone="warn">{BALANCE_CHANGED_TEXT}</Banner>}
          {instructions?.status === "NONE" && <p className="text-sm text-text-2">이 세션은 지시 없음 — 지금 보유가 규칙 계좌 비중에 맞아 매매할 것이 없습니다.</p>}
          {instructions?.status === "UNAVAILABLE" && <Banner tone="warn">{unavailableText(instructions.reason)}</Banner>}
          {instructions && (instructions.items ?? []).length > 0 && (
            <>
              {confirmable.length > 1 && (
                <div>
                  <Button size="sm" variant="primary" onClick={() => onConfirm(confirmable)} disabled={busy}>
                    전부 확인({confirmable.length})
                  </Button>
                </div>
              )}
              <IsaInstructionsTable rows={instructions.items ?? []} onConfirm={(item) => onConfirm([item])} onSkip={onSkip} disabled={busy} caption={instructionsTitle} />
              <p className="text-xs leading-relaxed text-text-3">{tradeGuide(instructions.open, instructions.targetAt)}</p>
              <p className="text-xs leading-relaxed text-text-3">{MIDDAY_GUIDE}</p>
            </>
          )}
          {recent.length > 0 && (
            <div className="flex flex-col gap-2">
              <div>
                <Button size="sm" variant="ghost" expanded={recentOpen} onClick={() => setRecentOpen((open) => !open)}>
                  {recentOpen ? "지난 지시 접기" : `지난 지시 보기(${recent.length})`}
                </Button>
              </div>
              {recentOpen && <IsaRecentInstructionsTable rows={recent} />}
            </div>
          )}
        </div>
      </Card>

      {stops.length > 0 && (
        <Card title="장중 스탑 매도 지시" subtitle="규칙 계좌가 트레일링 스탑으로 판 종목 — 감지 즉시 텔레그램으로 알립니다(종목·수량만). 매매했으면 '확인'을 누르세요">
          <div className="flex flex-col gap-3">
            {confirmableStops.length > 1 && (
              <div>
                <Button size="sm" variant="primary" onClick={() => onConfirmStops(confirmableStops)} disabled={busy}>
                  전부 확인({confirmableStops.length})
                </Button>
              </div>
            )}
            <IsaStopInstructionsTable rows={stops} onConfirm={(row) => onConfirmStops([row])} disabled={busy} />
            <p className="text-xs leading-relaxed text-text-3">{STOP_GUIDE}</p>
          </div>
        </Card>
      )}

      <Card
        title="잔고"
        subtitle="지금 잔고가 정답입니다 — 실제와 다르면 고치세요. 평가는 실시간 가격(표시 전용 — 못 받은 종목은 서버가 준 직전 종가, 밤 관측치), 지시는 직전 종가로 계산합니다"
        actions={
          <Button size="sm" onClick={onAddPosition} disabled={busy}>
            행 추가
          </Button>
        }
      >
        <IsaPositionsTable rows={valuation.positions} onEdit={onEditPosition} onDelete={onDeletePosition} disabled={busy} />
      </Card>

      <Card title="매매 내역" subtitle="'확인'으로 잔고에 반영한 매매(최근 200, 최근 순) — 체결가가 다르면 잔고에서 가격을 고치세요. 잘못 눌렀으면 되돌리세요">
        <IsaTradesTable rows={data.trades ?? []} onUndo={onUndo} disabled={busy} />
      </Card>
    </>
  );
}

/** 서버 안내 — 글자인 줄만(빈 줄 뺌). */
function cleanNotes(notes: readonly unknown[] | null | undefined): string[] {
  return (notes ?? []).filter((note): note is string => typeof note === "string" && note.trim() !== "");
}

function NoteList({ notes }: { notes: readonly string[] }) {
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-text-2" aria-label="ISA 계좌 안내">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}

/** 표가 없을 때(available:false) — 서버 문구(message)와 안내(notes)를 한 배너에, 둘 다 없으면 일반 문구. */
function UnavailableNotice({ message, notes }: { message: string | null; notes: readonly unknown[] | null }) {
  const lines = cleanNotes(notes);
  const text = message && message.trim() !== "" ? message.trim() : null;
  return (
    <Banner tone="warn">
      {text === null && lines.length === 0 ? (
        "ISA 계좌 잔고를 읽을 수 없습니다(서버 준비 전)."
      ) : (
        <div className="flex flex-col gap-1">
          {text && <p>{text}</p>}
          {lines.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5" aria-label="ISA 계좌 안내">
              {lines.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Banner>
  );
}
