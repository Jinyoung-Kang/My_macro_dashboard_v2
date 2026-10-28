"use client";

import { useState } from "react";
import { Banner, Button, Card } from "@/components/ui";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatNumber } from "@/lib/format";
import { PAPER_SOURCES } from "@/lib/paper";
import {
  krDecisionWindowText,
  krInitResultText,
  krStartRecordLine,
  krStartResultView,
  krStartState,
  latestStartRecord,
} from "@/lib/paperKr";
import { formatMoney } from "@/lib/paperMarket";
import type {
  PaperKrInitResult,
  PaperKrStartResult,
  PaperOverviewResponse,
  PaperSettingsResponse,
  PaperStatusResponse,
} from "@/lib/types";

/**
 * 한국 개요의 출발 상태 카드(2단계 명세 §4-8·§4-16 F1b) — 한국 네 계좌는 출발일 S 밤의 결정으로 S+1 시가에 함께 출발합니다(사후 체결 없음,
 * 미국의 '초기화 다시 누르기'·계좌별 시작 카드는 없음). 상태는 lib/paperKr krStartState:
 *
 * - 쉼(출발일 없음): 무엇이 있어야 출발하는지만 — 단추 없음(서버가 초기화를 400으로 막음)
 * - 초기화 전: '한국 초기화'(POST init?market=KR — 멱등, 서버 400 문구 그대로)
 * - 출발 대기(네 계좌 모두 시작 전): 출발일·결정 창(설정 kr.decisionTimeKst~kr.decisionDeadlineKst)·그 세션 최근 출발 기록과 '출발 지금
 *   실행'(확인 창 → POST run/initial-decision?market=KR, 본문 없음 — 정기 출발을 같은 창·같은 게이트로 앞당김, Claude 출발 호출은 수동 문턱)
 * - 출발함: 카드 없음(단추 결과는 남김)
 *
 * 쓰기 단추는 운영자 화면에만 있습니다(모의매매 전체가 운영자 전용 — lib/access). 성공하면 onChanged로 개요를 다시 읽습니다.
 */
export function KrStartSection({
  overview,
  status,
  onChanged,
}: {
  overview: PaperOverviewResponse;
  /** 상태 응답(호출 사용량 — 수동 호출 문턱). 못 읽었으면 null(문턱은 "—"). */
  status: PaperStatusResponse | null;
  onChanged: () => void;
}) {
  const paths = endpoints.paper.market("KR");
  const state = krStartState(overview);
  // 결정 창은 설정 값입니다(문장에 22:30을 박지 않음). 출발을 기다릴 때만 읽습니다.
  const settings = useApi<PaperSettingsResponse>(state.kind === "waiting" ? endpoints.paper.settings : null);
  const init = useAsyncAction(() => apiPost<PaperKrInitResult>(paths.init), "한국 초기화를 하지 못했습니다.");
  const start = useAsyncAction(() => apiPost<PaperKrStartResult>(paths.runInitialDecision), "한국 출발을 실행하지 못했습니다.");
  const initElapsed = useElapsedSeconds(init.busy);
  const startElapsed = useElapsedSeconds(start.busy);
  const [confirming, setConfirming] = useState(false);

  const runInit = async () => {
    if (await init.run()) onChanged();
  };
  const runStart = async () => {
    const ok = await start.run();
    // 성공·실패 모두 확인 창을 닫습니다 — 실패 사유(창 밖·게이트 미달 400)는 아래 경고로 남습니다.
    setConfirming(false);
    if (ok) onChanged();
  };

  const initResult = init.result && (
    <Banner tone={init.result.ok === false ? "warn" : "info"}>한국 초기화 — {krInitResultText(init.result)}</Banner>
  );
  const startView = start.result ? krStartResultView(start.result) : null;
  const startResult = startView && (
    <Banner tone={startView.tone}>
      <p>{startView.text}</p>
      {startView.detail.length > 0 && <p className="mt-1 text-xs">{startView.detail.join(" · ")}</p>}
    </Banner>
  );
  const today = status?.available ? status.apiUsage?.today ?? null : null;
  const manualLimit = today?.manualLimit ?? null;
  const cash = overview.books?.find((book) => typeof book.initialCash === "number")?.initialCash ?? null;

  if (state.kind === "started") {
    return (
      <>
        {initResult}
        {startResult}
      </>
    );
  }

  if (state.kind === "dormant") {
    return (
      <Card title="한국 출발" subtitle="쉬는 동안에는 초기화·출발 단추가 없습니다" source={PAPER_SOURCES.krLedger}>
        <p className="text-sm leading-relaxed text-body">
          출발일이 정해지면 한국 초기화(네 계좌·kr.* 기본 설정)를 한 뒤, 출발일 밤 결정 창에서 네 계좌가 함께 출발합니다(다음 KR 거래일 시가
          체결 — 사후 체결 없음). 지금 쉬는 사유는 화면 위 경고에 있습니다.
        </p>
      </Card>
    );
  }

  if (state.kind === "init") {
    return (
      <Card title="한국 초기화" subtitle={`출발일 ${state.startDate}`} source={PAPER_SOURCES.krLedger}>
        <p className="text-sm leading-relaxed text-body">
          초기화하면 한국 네 계좌(규칙 · Claude · KODEX 200 · 한국 60/40)를 계좌마다 {cash === null ? "배포 설정의 처음 현금" : formatMoney(cash, "KR")}
          의 &apos;시작 전&apos;(현금만)으로 만들고, 설정 행에 없는 kr.* 키를 기본값으로 채웁니다(판을 한 번 올림). 사후 체결은 없습니다 —
          출발은 출발일 밤 결정 창에서 정기 결정 작업이나 &apos;출발 지금 실행&apos;이 합니다. 여러 번 눌러도 이미 있는 계좌·설정은 그대로입니다.
        </p>
        <div className="mt-3">
          <Button variant="primary" onClick={() => void runInit()} disabled={init.busy}>
            {init.busy ? `초기화 중… ${initElapsed}초` : "한국 초기화"}
          </Button>
        </div>
        {/* 출발일 없음·달력 없음·거래일 아님·출발 기한 지남(400) — 서버 문구 그대로. */}
        {init.error && <div className="mt-3"><Banner tone="warn">{init.error}</Banner></div>}
        {initResult && <div className="mt-3">{initResult}</div>}
      </Card>
    );
  }

  const record = latestStartRecord(overview.jobs);
  const windowText = settings.data?.available ? krDecisionWindowText(settings.data.body) : `${EMPTY} ~ ${EMPTY} KST`;
  return (
    <Card title="한국 출발 대기" subtitle={`출발일 ${state.startDate} · 결정 창 ${windowText}`} source={PAPER_SOURCES.decisions}>
      <p className="text-sm leading-relaxed text-body">
        네 계좌가 모두 &apos;시작 전&apos;입니다. 출발일 밤 결정 창에서 정기 결정 작업이 자료 게이트를 기다려 네 계좌를 한 번에 출발시키고(다음 KR
        거래일 시가 체결), 아래 단추는 같은 창·같은 게이트·같은 네 계좌 몫으로 그것을 앞당깁니다. 창 밖·게이트 미달·이미 미룬 세션이면 서버가
        거절합니다. 출발 계획이 실패하면(Claude 호출 실패 등) 네 계좌 모두 다음 KR 거래일로 함께 미뤄집니다.
      </p>
      <p className="mt-2 text-xs text-muted">
        {record ? `최근 출발 기록: ${krStartRecordLine(record)}` : "이 출발의 작업 기록은 아직 없습니다(결정 창에서 기다리거나 미루면 한 줄이 생깁니다)."}
      </p>
      <div className="mt-3">
        <Button variant="primary" onClick={() => setConfirming(true)} disabled={start.busy}>
          {start.busy ? `출발 실행 중… ${startElapsed}초` : "출발 지금 실행"}
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="한국 출발을 지금 실행할까요?"
        description={
          <>
            정기 출발과 같은 창·같은 자료 게이트로 네 계좌를 한 번에 출발시킵니다. Claude를 한 번 부릅니다(Claude 계좌 출발 몫 — 수동 호출이라
            하루 호출 중 수동 문턱 {manualLimit === null ? EMPTY : `${formatNumber(manualLimit, 0)}회`} 안에서만
            {today ? `, 오늘 ${formatNumber(today.calls, 0)}회 씀` : ""}). 실패하면 그 세션은 다음 KR 거래일로 미뤄지고 같은 창에서 다시 부르지 않습니다.
          </>
        }
        confirmLabel="출발 실행"
        busy={start.busy}
        onConfirm={() => void runStart()}
      />
      {/* 창 밖·게이트 미달·이미 미룬 세션(400) — 서버 문구 그대로. */}
      {start.error && <div className="mt-3"><Banner tone="warn">{start.error}</Banner></div>}
      {startResult && <div className="mt-3">{startResult}</div>}
      {initResult && <div className="mt-3">{initResult}</div>}
    </Card>
  );
}
