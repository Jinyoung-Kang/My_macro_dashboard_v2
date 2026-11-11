"use client";

import { StatGrid, StatTile } from "@/components/patterns";
import { Banner, Button, Card, ErrorState, Freshness, Loading } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { deltaColor, formatNumber, formatPercent, formatSigned } from "@/lib/format";
import {
  bookStatusLabel,
  CANCEL_BLOCKED_TEXT,
  cancelBlocked,
  cancelGaveUpCount,
  cancelGaveUpText,
  canResume,
  canUpdate,
  disableDoneUnresolvedText,
  disableFeedback,
  EMERGENCY_STEPS,
  enableBlock,
  formatWon,
  jobStallText,
  jobStalled,
  lossLimitText,
  preflightNote,
  REAL_TRADE_SOURCE,
  realTradeChip,
  realTradePnl,
  serverSwitchState,
  serverSwitchText,
  serverUnknownText,
  showDisableError,
  skipDayText,
  sourceBookLabel,
  toNumber,
  unresolvedOffCount,
  windowText,
} from "@/lib/realtrade";
import type { RealTradeStatusResponse } from "@/lib/types/realtrade";
import { useRealTrade, type RealTradeContextValue } from "./RealTradeProvider";
import { RealTradeEvents, RealTradeOrders } from "./RealTradeTables";
import { RealTradeToggle } from "./RealTradeToggle";

const TITLE = "실제 매매 — 모의 계좌 따라 하기";

/**
 * 실제 매매 칸(ADR 0028, 명세 §8) — 모의매매(한국) 실제 계좌 탭 맨 위. 토스증권 실제 계좌의 원화 자산 전부가 고른 모의 한국 책을 따라 자동으로 사고팝니다.
 *
 * <p>상태는 RealTradeProvider가 15초마다 읽고, 이 칸은 모의 개요·실제 계좌 조회와 따로라 그쪽이 실패해도 그려집니다. 끄기 단추는 켜짐·멈춤·끄는 중이면 늘,
 * 상태를 읽지 못했을 때도 보입니다(확인 창 없이 바로). 칸 내용: 상태 칩(꺼짐·켜짐·멈춤(사유)·끄는 중·서버에서 꺼짐)·서버 스위치·따라 하는 책·운용 평가액·
 * 기준 대비 손익(부호와 색)·손실 한도·오늘 창과 쉬는 사유·최근 실제 주문·이벤트·멈춤 해제와 설정 바꾸기(확인 글자 + 비밀번호).
 * 서버 스위치가 꺼져 이 기능이 미체결을 취소할 수 없거나(SEC-5) 정기 작업이 3분 넘게 주기를 끝내지 못했거나(RT-BE-6·RT2-FE-2) 취소를 5번 보내고도
 * 살아 있는 미체결이 있으면(RT2-FE-3) 위험 배너로, 꺼졌는데 결과를 모르는 주문이 남았으면 경고 배너로 사람이 할 일을 적습니다(새로 고친 화면에서도).
 *
 * <p>미국 화면은 '준비 중'과 꺼진 단추만 그립니다(상태를 읽지 않음).
 */
export function RealTradePanel() {
  const rt = useRealTrade();
  if (!rt) {
    return null;
  }
  return (
    <div role="region" aria-label="실제 매매">
      {rt.supported ? <KoreaPanel rt={rt} /> : <UsPanel />}
    </div>
  );
}

function UsPanel() {
  return (
    <Card title="실제 매매 — 미국(달러)" actions={<RealTradeToggle />}>
      <p className="text-sm text-text-2">
        미국 실제 매매는 준비 중입니다. 달러 자산은 새 결정(ADR)으로 엽니다 — 지금은 모의매매(한국)의 실제 계좌 탭에서 원화 자산만 운용합니다.
      </p>
    </Card>
  );
}

function KoreaPanel({ rt }: { rt: RealTradeContextValue }) {
  const { status, loading, statusError, refreshError, reload } = rt;
  return (
    <Card
      title={TITLE}
      subtitle="토스증권 실제 계좌의 원화 자산 전부가 고른 모의 한국 계좌를 따라 자동으로 사고팝니다(모의 계좌 자체는 주문하지 않음)"
      source={REAL_TRADE_SOURCE}
      actions={
        <>
          {status && <Freshness refreshError={refreshError} />}
          <RealTradeToggle />
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* 한 번 실패했으면 다시 읽는 동안에도 '읽는 중'으로 돌아가지 않고 오류 안내를 남깁니다(RT2-FE-1). */}
        {loading && !status && !statusError && <Loading label="실제 매매 상태를 읽는 중…" />}
        {/* 상태를 읽지 못해도(읽는 중에도) 끄기 단추는 위에 남습니다(끄기는 서버가 늘 받음). */}
        {statusError && !status && (
          <ErrorState
            message={`실제 매매 상태를 읽지 못했습니다 — ${statusError}. 끄기는 상태와 관계없이 보낼 수 있습니다.`}
            onRetry={() => void reload()}
          />
        )}
        <ActionFeedback rt={rt} />
        {status && status.available !== true && (
          <Banner tone="warn">{status.message || "실제 매매 상태를 읽을 수 없습니다(서버 준비 전)."}</Banner>
        )}
        {status && status.available === true && <StatusBody status={status} rt={rt} />}
      </div>
    </Card>
  );
}

/** 끄기를 보낸 뒤의 안내가 보이는가(끄기가 실패하지 않았을 때) — 보이면 같은 내용의 칸 배너는 StatusBody가 겹쳐 띄우지 않습니다. */
function feedbackShown(rt: RealTradeContextValue): boolean {
  return rt.disableSent && !rt.disableError;
}

/**
 * 끄기·켜기류 결과 — 끄기를 보낸 뒤 '새 주문 멈춤 — 미체결 취소 중' → 꺼짐, 끄기 실패면 비상 순서. 사람이 할 일이 남았으면 단정하지 않습니다
 * (lib/realtrade `disableFeedback`): 취소를 5번 보내고도 살아 있는 미체결(위험), 서버 스위치가 꺼져 이 기능이 취소할 수 없음(SEC-5), 꺼졌지만 결과를
 * 모르는 주문(경고 — RT2-FE-3). 끄기를 보내지 않은 화면(새로 고침·다른 기기)에는 같은 내용이 StatusBody의 배너로 보입니다.
 */
function ActionFeedback({ rt }: { rt: RealTradeContextValue }) {
  const feedback = disableFeedback(rt.status);
  return (
    <>
      {showDisableError(rt.disableError, rt.status, rt.readFailed) && (
        <Banner tone="danger">
          <p>실제 매매를 끄지 못했습니다 — {rt.disableError}. 끄기 단추를 다시 누르세요.</p>
          <p className="mt-1 text-xs">{EMERGENCY_STEPS}</p>
        </Banner>
      )}
      {feedbackShown(rt) && (
        <div role="status">
          <Banner tone={feedback.tone}>{feedback.text}</Banner>
        </div>
      )}
      {rt.notice && (
        <div role="status">
          <Banner tone="ok">{rt.notice}</Banner>
        </div>
      )}
    </>
  );
}

function StatusBody({ status, rt }: { status: RealTradeStatusResponse; rt: RealTradeContextValue }) {
  const chip = realTradeChip(status);
  const equity = toNumber(status.lastPreflight?.equity);
  const pnl = realTradePnl(status);
  const lossPct = toNumber(status.lossLimitPct);
  const blocked = cancelBlocked(status);
  // 서버 스위치를 모르면(수집기 상태를 읽지 못함) '꺼져 있어 주문이 나가지 않습니다'를 띄우지 않고 '읽지 못함 — 다시 읽는 중'을 적습니다(RT3-UI-1).
  const server = serverSwitchState(status);
  const unfinished = toNumber(status.unfinishedOrders);
  // 정기 작업 멈춤은 이 응답의 서버 시각(serverTime)과 견줍니다 — 없으면 이 상태를 받은 시각(그것도 없으면 지금). 둘 다 그 응답의 시각이라 상태 읽기가
  // 실패하는 동안 오래된 값으로 멈춤을 짐작하지 않습니다(RT2-FE-2).
  const stalled = jobStalled(status, (rt.loadedAt ?? new Date()).getTime());
  // 취소 포기·결과 모름 배너 — 끄기 뒤 안내(ActionFeedback)가 같은 내용을 이미 보이면 겹쳐 띄우지 않습니다.
  const feedbackKind = feedbackShown(rt) ? disableFeedback(status).kind : null;
  const gaveUp = cancelGaveUpCount(status);
  const unresolved = unresolvedOffCount(status);
  const book = status.books?.find((entry) => entry.code === status.sourceBook);
  const block = enableBlock(status);
  const today = status.today;
  const windows = today?.windows ?? [];

  if (status.supported !== true) {
    return <p className="text-sm text-text-2">이 시장의 실제 매매는 준비 중입니다.</p>;
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-sm font-semibold" aria-label={`상태: ${chip.label}`}>
          <StatusText tone={chip.tone}>{chip.label}</StatusText>
        </span>
        <span className="text-sm text-text-2">
          따라 하는 계좌:{" "}
          <span className="text-text">
            {status.sourceBook ? sourceBookLabel(status.sourceBook, status.sourceLabel) : "고르지 않음"}
          </span>
          {book ? ` (모의 ${bookStatusLabel(book.status)})` : ""}
        </span>
        <span className="text-xs text-text-3">서버 스위치: {serverSwitchText(status.serverEnabled)}</span>
      </div>

      {stalled && (
        <Banner tone="danger">
          <p>
            정기 작업이 멈춘 것 같습니다 — {jobStallText(status)}(3분 넘게 지남). 새 주문·미체결 취소·체결 추적이 돌지 않을 수 있으니 비상 끄기 절차를
            따르세요.
          </p>
          <p className="mt-1 text-xs">{EMERGENCY_STEPS}</p>
        </Banner>
      )}
      {gaveUp !== null && feedbackKind !== "gave-up" && <Banner tone="danger">{cancelGaveUpText(gaveUp)}</Banner>}
      {unresolved !== null && feedbackKind !== "unresolved" && <Banner tone="warn">{disableDoneUnresolvedText(unresolved)}</Banner>}
      {blocked && (
        <Banner tone="danger">
          {CANCEL_BLOCKED_TEXT}
          {unfinished !== null && unfinished > 0 ? ` (이 기능의 미체결 ${formatNumber(unfinished, 0)}건)` : ""}
        </Banner>
      )}
      {status.state === "HALTED" && (
        <Banner tone="danger">
          이상 멈춤 — 사유 {status.haltReason ?? "모름"}.{" "}
          {blocked
            ? "새 주문과 매도를 멈췄습니다(미체결 취소는 위 안내대로 토스증권 앱에서)."
            : "이 기능의 미체결 취소를 보내고 매도도 멈췄습니다."}{" "}
          토스증권 앱에서 주문·보유를 확인한 뒤 &lsquo;멈춤 해제&rsquo;를 누르세요.
        </Banner>
      )}
      {status.state === "LIVE" && status.buysPaused === true && (
        <Banner tone="warn">
          손실 한도({lossPct === null ? "—" : `${lossLimitText(lossPct)}%`})에 걸려 새 매수를 멈췄습니다 — 매도는 계속 따라
          합니다. &lsquo;멈춤 해제&rsquo;로 풉니다.
        </Banner>
      )}
      {status.state === "LIVE" && server === "off" && !blocked && (
        <Banner tone="warn">
          화면 스위치는 켜져 있지만 운영 서버의 매매 스위치가 꺼져 있어 주문이 나가지 않습니다. 이 기능이 미체결을 취소할 수 없습니다 — 미체결이 있으면
          토스증권 앱에서 직접 취소하세요.
        </Banner>
      )}
      {status.state === "LIVE" && server === "unknown" && !blocked && <Banner tone="warn">{serverUnknownText(status.serverEnabled)}</Banner>}
      {status.state === "OFF" && block && <p className="text-xs text-text-3">{block}</p>}

      {(canResume(status) || canUpdate(status)) && (
        <div className="flex flex-wrap gap-2">
          {canResume(status) && (
            <Button size="sm" variant="primary" onClick={() => rt.openDialog("resume")} disabled={rt.disableBusy}>
              멈춤 해제
            </Button>
          )}
          {canUpdate(status) && (
            <Button size="sm" onClick={() => rt.openDialog("update")} disabled={rt.disableBusy}>
              설정 바꾸기
            </Button>
          )}
        </div>
      )}

      <StatGrid cols={3}>
        <StatTile
          label="운용 평가액"
          value={equity}
          format={(value) => formatNumber(value, 0)}
          unit="원"
          note={preflightNote(status.lastPreflight, status.serverTime)}
          emptyReason="아직 읽은 값 없음"
        />
        <StatTile
          label="기준 대비 손익"
          value={pnl.amount}
          format={(value) => formatSigned(value, 0)}
          unit="원"
          valueClassName={deltaColor(pnl.amount, 0)}
          note={
            pnl.basis === "total"
              ? `기준 총액 ${formatWon(pnl.base)} 대비(지금 총액 ${formatWon(pnl.now)}) · 기준 평가액 ${formatWon(status.baselineEquity)}의 ${formatPercent(pnl.pct)}(대시보드 계산)`
              : `기준 평가액 ${formatWon(status.baselineEquity)} 대비 ${formatPercent(pnl.pct)}(대시보드 계산)`
          }
        />
        <StatTile
          label="손실 한도"
          value={lossPct}
          format={lossLimitText}
          unit="%"
          note={
            pnl.line === null
              ? "멈춤선 —"
              : `${pnl.basis === "total" ? "총액이 " : ""}멈춤선 ${formatWon(Math.round(pnl.line))} 이하면 새 매수 멈춤(매도는 계속)`
          }
        />
      </StatGrid>

      <section aria-label="오늘 창" className="text-sm">
        <h3 className="text-sm font-medium text-text">오늘{today?.date ? `(${today.date})` : ""}</h3>
        {today?.skipReason ? (
          <p className="mt-1 text-warn">{skipDayText(today.skipReason)}</p>
        ) : windows.length > 0 ? (
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-text-2">
            {windows.map((window, index) => (
              <li key={index} className="tabular-nums">
                {windowText(window)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-text-3">오늘 창 정보 없음(장 운영 정보를 아직 받지 않았거나 켜져 있지 않음)</p>
        )}
      </section>

      <RealTradeOrders rows={status.orders ?? []} />
      <RealTradeEvents rows={status.events ?? []} />

      <p className="text-xs leading-relaxed text-text-3">
        켠 동안 토스증권 앱에서 국내 주식을 직접 사고팔지 마세요 — 앱에서 산 국내 주식은 다음 맞추기에서 팔리고, 원화를 넣으면 다음 맞추기에 투자됩니다.
        모의 계좌가 장중 스탑으로 팔면 이 계좌도 그 시각부터 3분 안에 시장가로 팝니다(종가로 파는 스탑은 그날 종가 단일가에서, 개장 10분 전에는 팔지 않음). 텔레그램 알림은 건수·상태만 보냅니다.
      </p>
    </>
  );
}
