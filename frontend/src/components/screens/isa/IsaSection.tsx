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
  canConfirmTrade,
  COST_NOTE,
  formatShares,
  formatWon,
  instructionWhenText,
  ISA_BANNER,
  ISA_SOURCE,
  isaBasisNote,
  isaBasisText,
  type IsaLiveQuote,
  type IsaValuation,
  isaValuation,
  kindLabel,
  LEDGER_CHANGED_TEXT,
  ledgerRowForInstruction,
  MIDDAY_GUIDE,
  PENDING_INSTRUCTIONS_GUIDE,
  sessionLabel,
  sessionStatusLabel,
  sideLabel,
  STOP_GUIDE,
  symbolText,
  targetClock,
  tradeGuide,
  unavailableText,
  unpricedText,
} from "@/lib/isa";
import { liveKey, liveSecondsText, liveShown } from "@/lib/livePrices";
import type { IsaInstructionItem, IsaLedgerRow, IsaOkResponse, IsaResponse } from "@/lib/types/isa";
import { IsaLedgerDialog, type IsaLedgerTarget } from "./IsaLedgerDialog";
import { IsaStartDialog } from "./IsaStartDialog";
import { IsaHoldingsTable, IsaInstructionsTable, IsaLedgerTable, IsaRecentInstructionsTable, IsaStopInstructionsTable } from "./IsaTables";
import { postConfirmInstructions, postDeleteLedger, postSkipInstruction, sendIsa } from "./isaRequests";

/** 다시 읽는 주기 — 장부는 밤 결정·자동 기록·사용자 고침 때만 바뀝니다(개요와 같은 1분). */
const POLL_MS = 60_000;

/** 고치기 뒤 안내. */
const SAVED_TEXT: Readonly<Record<IsaLedgerTarget["mode"], string>> = {
  add: "장부에 행을 더했습니다 — 다음 지시는 이 장부로 계산합니다.",
  edit: "장부 행을 고쳤습니다 — 다음 지시는 고친 장부로 계산합니다.",
  instruction: "체결을 장부에 적었습니다 — 이 지시는 자동 기록하지 않습니다.",
};

/**
 * ISA 계좌 칸(ADR 0029, 명세 §8) — 모의매매(한국)의 'ISA 계좌' 탭. 연결되지 않은 다른 증권사 계좌를 한국 규칙 계좌 메커니즘으로 운용합니다: 이 화면은
 * 장부와 '다음 시가에 무엇을 몇 주'를 보이고, 사용자가 그 지시(화면·텔레그램)를 보고 직접 매매합니다. 주문 기능은 없습니다.
 *
 * <p>GET /api/manual/isa 하나를 1분마다 읽습니다(모의 개요와 따로 — 개요가 실패해도 그립니다). 시작 전이면 '시작' 창(시작 현금 + 시작 매수 목록 붙여 넣기),
 * 시작 뒤면 요약(순입금(시작 현금 포함)·평가액·손익(부호·색)·현금, 비용 0으로 어림) → 다음 시가 매매 지시(줄마다 체결 고치기·건너뜀, 지난 지시) →
 * 처리 안 된 지난 지시(앞 세션의 기록 전 지시 — 처리해야 다음 지시를 만듦) → 보유 → 장부(고치기·지우기)·행 추가 순입니다(이 화면을 보고 바로 매매하므로
 * 지시를 위로). 쓰기는 isaRequests의 apiPost(endpoints.isa.*)뿐이고, 결과가 나오면 장부를 다시 읽습니다. 서버 오류는 코드별 문구(lib/isa)로 보입니다.
 *
 * <p>평가(명세 docs/specs/2026-11-06-us-costs-backfill.md §6): 탭 머리의 주기 상자(components/LiveIntervalSelect — 다른 화면의 '실시간 시세'와 같은 값)로
 * 고른 주기마다 보유 종목의 실시간 가격(hooks/useLivePrices — ADR 0024 SSE, 표시 전용)을 받아 평가액·손익·비중을 화면에서 다시 셉니다(lib/isa
 * isaValuation — 못 받은 종목은 서버가 준 직전 종가, 표에 '직전 종가'). 기준 시각은 받은 가격의 시각 중 가장 이른 것(초까지)입니다. 서버 장부·지시는
 * 그대로(직전 종가)입니다.
 *
 * <p>이 모듈을 밖에서 가져오는 곳은 PaperScreen 하나입니다(경계 시험 __tests__/isaBoundary.test.ts). 미국 화면에는 이 탭이 없습니다.
 */
export function IsaSection() {
  const { data, loading, error, refreshError, reload } = useApi<IsaResponse>(endpoints.isa.account, POLL_MS);
  const reloadNow = useCallback(() => void reload(), [reload]);
  const [startOpen, setStartOpen] = useState(false);
  const [ledgerTarget, setLedgerTarget] = useState<IsaLedgerTarget | null>(null);
  const [deleteRow, setDeleteRow] = useState<IsaLedgerRow | null>(null);
  const [skipItem, setSkipItem] = useState<IsaInstructionItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 지우기·건너뜀(확인 창) — 한 동작 상태를 함께 씁니다(새 동작을 시작하면 앞 오류를 지움).
  const send = useCallback((request: () => Promise<IsaOkResponse>) => sendIsa(request, reloadNow), [reloadNow]);
  const action = useAsyncAction(send, "요청을 처리하지 못했습니다.");

  const confirmDelete = async () => {
    const row = deleteRow;
    if (!row) return;
    setNotice(null);
    const ok = await action.run(() => postDeleteLedger(row.id));
    setDeleteRow(null);
    if (ok) setNotice("장부 행을 지웠습니다 — 다음 지시는 지운 뒤의 장부로 계산합니다.");
    reloadNow();
  };

  const confirmSkip = async () => {
    const item = skipItem;
    if (!item) return;
    setNotice(null);
    const ok = await action.run(() => postSkipInstruction(item.id));
    setSkipItem(null);
    if (ok) setNotice("지시를 건너뜀으로 두었습니다 — 장부에 쓰지 않고, 다음 지시는 지금 장부로 계산합니다.");
    reloadNow();
  };

  // '매매함' — 누를 수 있고 되돌릴 수 있어 확인 창 없이 바로(장부는 바꾸지 않음).
  const confirmTrades = async (ids: readonly number[], confirmed: boolean) => {
    setNotice(null);
    const ok = await action.run(() => postConfirmInstructions(ids, confirmed));
    if (ok) setNotice(confirmed ? "매매함으로 표시했습니다 — 장 중반 확인 알림에서 뺍니다." : "매매함 표시를 지웠습니다.");
    reloadNow();
  };

  const available = data?.available === true;
  const started = available && data?.started === true;

  // 실시간 평가 — 보유 종목의 가격을 고른 주기마다 받아 평가액·손익·비중을 다시 셉니다(표시 전용, 장부·지시는 직전 종가).
  const [liveSeconds] = useLiveSeconds();
  const holdings = started ? data?.holdings : null;
  const liveItems = useMemo(() => (holdings ?? []).map((row) => liveKey("KR", row.symbol)), [holdings]);
  const realtime = useLivePrices(liveItems, liveSeconds, started);
  const valuation = useMemo(() => {
    const quotes: Record<string, IsaLiveQuote> = {};
    // 멈춘 값은 실시간으로 쓰지 않습니다(useLivePrices 계약 — QA-183·184): 연결이 끊기면 서버 값(직전 종가), 뒤 응답에서 빠진 종목은 직전 종가.
    for (const row of realtime.disconnected ? [] : (holdings ?? [])) {
      const key = liveKey("KR", row.symbol);
      if (realtime.missing.includes(key)) continue;
      const price = Object.hasOwn(realtime.prices, key) ? realtime.prices[key] : null;
      if (!price) continue;
      const shown = liveShown(price);
      const receivedAt = realtime.receivedAtByKey[key];
      quotes[row.symbol] = {
        price: shown.price,
        at: shown.tradedAt ?? (typeof receivedAt === "number" ? new Date(receivedAt).toISOString() : null),
      };
    }
    return isaValuation(holdings, started ? data?.summary : null, quotes);
  }, [holdings, started, data?.summary, realtime.prices, realtime.receivedAtByKey, realtime.missing, realtime.disconnected]);

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
      {loading && !data && <Loading label="ISA 계좌 장부를 읽는 중…" />}
      {error && !data && <ErrorState message={`ISA 계좌 장부를 읽지 못했습니다 — ${error}`} onRetry={reloadNow} />}
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
              시작 현금과, 이미 산 종목이 있으면 그 수량·체결가(시작 매수 목록)를 적으면 장부가 시작됩니다. 그 뒤 한국 규칙 계좌의 밤 결정(22:30)마다 다음
              시가의 매매 지시를 만들어 이 화면과 텔레그램으로 알립니다. 시작은 한 번만 됩니다.
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
          onConfirm={(ids, confirmed) => void confirmTrades(ids, confirmed)}
          onAdd={() => {
            setNotice(null);
            setLedgerTarget({ mode: "add" });
          }}
          onEdit={(row) => {
            setNotice(null);
            setLedgerTarget({ mode: "edit", row });
          }}
          onDelete={(row) => {
            setNotice(null);
            setDeleteRow(row);
          }}
          onFix={(item) => {
            setNotice(null);
            const latest = data.instructions?.session ?? null;
            const session = item.session ?? latest;
            setLedgerTarget({
              mode: "instruction",
              item,
              row: ledgerRowForInstruction(data.ledger, item.id),
              session,
              // 개장 10분 뒤 시각 맞추기 지시면 그 시각(자동 기록 행과 같은 시각), 아니면 개장 시각 — 개장 시각은 최신 세션 것만 압니다(지난 세션은 09:00).
              open: item.targetAt ?? (session !== null && session === latest ? (data.instructions?.open ?? null) : null),
            });
          }}
          onSkip={(item) => {
            setNotice(null);
            setSkipItem(item);
          }}
        />
      )}

      <IsaStartDialog
        open={startOpen}
        onClose={() => setStartOpen(false)}
        onReload={reloadNow}
        onDone={(buyCount) => {
          setStartOpen(false);
          setNotice(
            `시작했습니다 — 시작 현금${buyCount > 0 ? `과 시작 매수 ${buyCount}줄` : ""}을 장부에 적었습니다. 첫 지시는 한국 규칙 계좌의 다음 밤 결정(22:30) 뒤에 만듭니다.`,
          );
          reloadNow();
        }}
      />
      <IsaLedgerDialog
        target={ledgerTarget}
        onClose={() => setLedgerTarget(null)}
        onReload={reloadNow}
        onDone={(target) => {
          setLedgerTarget(null);
          setNotice(SAVED_TEXT[target.mode]);
          reloadNow();
        }}
      />
      <ConfirmDialog
        open={deleteRow !== null}
        onOpenChange={(open) => {
          if (!open && !action.busy) setDeleteRow(null);
        }}
        title="장부 행 지우기"
        description={
          deleteRow
            ? `${kindLabel(deleteRow.kind)}${deleteRow.symbol ? ` ${symbolText(deleteRow.symbol, deleteRow.name)}` : ""} 행(#${deleteRow.id}, ${formatKst(deleteRow.at)})을 지웁니다. 되돌릴 수 없고, 다음 지시는 지운 뒤의 장부로 계산합니다.`
            : undefined
        }
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
            ? `${instructionWhenText(skipItem)}${sideLabel(skipItem.side)} ${symbolText(skipItem.symbol, skipItem.name)} ${formatShares(skipItem.quantity)}주 지시를 건너뜀으로 둡니다 — 장부에 쓰지 않습니다(매매하지 않았을 때). 되돌릴 수 없습니다.`
            : undefined
        }
        confirmLabel="건너뜀"
        busy={action.busy}
        onConfirm={() => void confirmSkip()}
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
  onAdd,
  onEdit,
  onDelete,
  onFix,
  onSkip,
}: {
  data: IsaResponse;
  /** 요약·보유의 평가 — 실시간 가격을 받았으면 그것으로 다시 센 값, 아니면 서버 값 그대로(lib/isa isaValuation). */
  valuation: IsaValuation;
  refreshError: string | null;
  busy: boolean;
  onConfirm: (ids: readonly number[], confirmed: boolean) => void;
  onAdd: () => void;
  onEdit: (row: IsaLedgerRow) => void;
  onDelete: (row: IsaLedgerRow) => void;
  onFix: (item: IsaInstructionItem) => void;
  onSkip: (item: IsaInstructionItem) => void;
}) {
  const account = data.account ?? null;
  const profit = valuation.profitLoss;
  const unpriced = unpricedText(valuation.unpriced);
  const instructions = data.instructions ?? null;
  const pending = data.pendingInstructions ?? [];
  const recent = data.recentInstructions ?? [];
  const stops = data.stopInstructions ?? [];
  const [recentOpen, setRecentOpen] = useState(false);
  const timedAt = targetClock(instructions?.targetAt);
  const timed = timedAt !== null;
  const instructionsTitle = timed ? "다음 매매 지시" : "다음 시가 매매 지시";
  const confirmable = (instructions?.items ?? []).filter(canConfirmTrade);
  const confirmOne = (item: IsaInstructionItem, confirmed: boolean) => onConfirm([item.id], confirmed);
  const notes = cleanNotes(data.notes);

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
              label="순입금(시작 현금 포함)"
              value={valuation.netDeposit}
              format={(value) => formatNumber(value, 0)}
              unit="원"
              note="입금 합 − 출금 합(장부 계산)"
            />
            <StatTile
              label="평가액"
              value={valuation.equity}
              format={(value) => formatNumber(value, 0)}
              unit="원"
              note={`보유 평가 ${formatWon(valuation.marketValue)} + 현금 ${formatWon(valuation.cash)}`}
            />
            <StatTile
              label="손익"
              value={profit}
              format={(value) => formatSigned(value, 0)}
              unit="원"
              valueClassName={deltaColor(profit, 0)}
              note={`순입금 대비 ${formatPercent(valuation.profitLossPct)}(대시보드 계산)`}
            />
            <StatTile label="현금" value={valuation.cash} format={(value) => formatNumber(value, 0)} unit="원" />
          </StatGrid>
          <p className="text-xs leading-relaxed text-text-3">{COST_NOTE}</p>
          {unpriced && (
            <Banner tone="warn">가격을 몰라 평가에서 뺀 종목: {unpriced} — 평가액·손익·비중에 들어가지 않았습니다.</Banner>
          )}
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
          {!instructions && (
            <p className="text-sm text-text-2">한국 규칙 계좌의 밤 결정(22:30)이 끝나면 10분 안에 다음 세션의 지시(시가 또는 개장 10분 뒤)를 만듭니다.</p>
          )}
          {instructions?.ledgerChanged === true && <Banner tone="warn">{LEDGER_CHANGED_TEXT}</Banner>}
          {instructions?.status === "NONE" && (
            <p className="text-sm text-text-2">이 세션은 지시 없음 — 지금 보유가 규칙 계좌 비중에 맞아 매매할 것이 없습니다.</p>
          )}
          {instructions?.status === "UNAVAILABLE" && <Banner tone="warn">{unavailableText(instructions.reason)}</Banner>}
          {instructions && (instructions.items ?? []).length > 0 && (
            <>
              {confirmable.length > 1 && (
                <div>
                  <Button size="sm" variant="primary" onClick={() => onConfirm(confirmable.map((item) => item.id), true)} disabled={busy}>
                    전부 매매함({confirmable.length})
                  </Button>
                </div>
              )}
              <IsaInstructionsTable
                rows={instructions.items ?? []}
                onConfirm={confirmOne}
                onFix={onFix}
                onSkip={onSkip}
                disabled={busy}
                caption={instructionsTitle}
              />
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
        <Card
          title="장중 스탑 매도 지시"
          subtitle="규칙 계좌가 트레일링 스탑으로 판 종목 — 감지 즉시 텔레그램으로 알리고(종목·수량만), 그날 밤 규칙 계좌와 같은 1분봉 값으로 장부에 자동 기록합니다"
        >
          <div className="flex flex-col gap-3">
            <IsaStopInstructionsTable rows={stops} />
            <p className="text-xs leading-relaxed text-text-3">{STOP_GUIDE}</p>
          </div>
        </Card>
      )}

      {pending.length > 0 && (
        <Card
          title="처리 안 된 지난 지시"
          subtitle="개장이 지났는데 체결 기록 전인 앞 세션 지시 — 이것을 처리해야 다음 지시를 만듭니다"
        >
          <div className="flex flex-col gap-3">
            <IsaInstructionsTable
              rows={pending}
              onConfirm={confirmOne}
              onFix={onFix}
              onSkip={onSkip}
              disabled={busy}
              caption="처리 안 된 지난 지시"
              withSession
            />
            <p className="text-xs leading-relaxed text-text-3">{PENDING_INSTRUCTIONS_GUIDE}</p>
          </div>
        </Card>
      )}

      <Card
        title="보유"
        subtitle="장부의 종목별 수량 × 실시간 가격(표시 전용 — 못 받은 종목은 서버가 준 직전 종가, 밤 관측치). 지시는 직전 종가로 계산합니다"
      >
        <IsaHoldingsTable rows={valuation.holdings} />
      </Card>

      <Card
        title="장부"
        subtitle="입출금·매수·매도·조정 행(최근 200, 최근 순) — 이 장부가 정본이고, 고치면 다음 지시가 고친 장부로 계산됩니다"
        actions={
          <Button size="sm" onClick={onAdd} disabled={busy}>
            행 추가
          </Button>
        }
      >
        <IsaLedgerTable rows={data.ledger ?? []} onEdit={onEdit} onDelete={onDelete} disabled={busy} />
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
        "ISA 계좌 장부를 읽을 수 없습니다(서버 준비 전)."
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
