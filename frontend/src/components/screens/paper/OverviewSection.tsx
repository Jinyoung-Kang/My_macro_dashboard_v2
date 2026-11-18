"use client";

import { useEffect, useRef, useState } from "react";
import { useTickerName } from "@/hooks/useTickerNames";
import { MultiLineSeries } from "@/components/charts";
import { ChangeChip, type Column, DataTable, Empty, EstimateBadge, InspectorFrame, type InspectorContext, KpiStrip, RangeTabs, StaleBadge } from "@/components/patterns";
import { Button, Callout, Freshness, Panel, ROW_TRIGGER } from "@/components/ui";
import { AlertTriangleIcon, StatusText } from "@/components/ui/icons";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatKst } from "@/lib/format";
import {
  apiUsageView,
  type Badge,
  calendarLine,
  CLAUDE2_EXPOSURE_KEY,
  claude2BarsLine,
  stopWatchLine,
  claude2CheckpointLine,
  claudeExposureChart,
  earningsLine,
  exposureNote,
  frameworkBoundaryView,
  fundamentalsLine,
  initialDecisionResultView,
  initPrompt,
  initResultText,
  isTimedBook,
  jobOutcomeClass,
  jsonSummary,
  jsonTitle,
  navAxis,
  navChart,
  newsLine,
  PAPER_SOURCES,
  type PoolRow,
  quotesLine,
  type RiskResultView,
  riskResultView,
  rulesStartPrompt,
  type SelectedFilerRow,
  selectedFilersView,
} from "@/lib/paper";
import {
  type AccountTableRow,
  accountTableRows,
  heroBookCode,
  latestObserved,
  markersInWindow,
  NAV_RANGES,
  type NavRangeKey,
  navRangeKeys,
  navSeriesWindow,
  navTailNote,
  overviewHeroModel,
  overviewKpiItems,
  sameWindowIndex,
  withNavEstimateTail,
} from "@/lib/paperOverview";
import {
  jobsCardSubtitle,
  jobsEmptyMessage,
  KR_REFERENCE_KEY,
  KR_RISK_RUN_NOTE,
  krJobDetailText,
  krReferenceNotes,
  krRiskResultView,
  marketJobs,
  withKrReference,
} from "@/lib/paperKr";
import { accountsBasisText, currentSource, currentView } from "@/lib/paperCurrent";
import { marketMeta, type PaperMarketCode } from "@/lib/paperMarket";
import { allowedRangeKey } from "@/lib/patternRows";
import type {
  PaperBookSummary,
  PaperInitialDecisionResult,
  PaperInitResult,
  PaperJobRun,
  PaperKrRiskResult,
  PaperNavResponse,
  PaperOverviewResponse,
  PaperRiskResult,
  PaperStatusResponse,
} from "@/lib/types";
import { AccountComparisonCard } from "./AccountComparisonCard";
import { accountDetailTitleId } from "./AccountDetailPanel";
import { AccountInspector } from "./AccountInspector";
import { BOOK_COLORS, bookColor, REFERENCE_COLOR, SPARE_COLORS } from "./bookColors";
import { Claude2StartSection } from "./Claude2StartSection";
import { ClaudeStartSection } from "./ClaudeStartSection";
import { ExecutionExperimentCard } from "./ExecutionExperimentCard";
import { GateIndicatorBody } from "./GateIndicatorBody";
import { KrCollectionCard } from "./KrCollectionCard";
import { KrStartSection } from "./KrStartSection";
import type { RealtimeNav } from "@/lib/paperLive";
import { LiveValuationCard } from "./LiveValuationCard";
import { PaperBadge } from "./PaperBadge";
import { PaperTabAccount } from "./PaperTabHeader";

/**
 * Claude 노출 추이의 선 색 = 계좌 색(순자산 곡선과 같은 계좌가 같은 색 — 진행 기록 exposure-chart-colour-mapping, 작업대 P6 U5): 계좌1의 목표·실제는
 * 계좌1 주황(목표는 점선 — 결정이 정한 값, 실제는 실선 — 장부), 미국 계좌2의 실제는 계좌2 자주. 예전에는 실제 노출이 파랑이라 같은 화면 순자산 곡선의
 * 파랑(규칙 계좌)과 뜻이 엇갈렸습니다. 같은 색 두 선은 선 모양(점선/실선)과 범례 이름이 가르고(색만으로 구분하지 않음), 주황↔자주는 검증한 계좌 색
 * 쌍입니다(bookColors.ts). 한 축(%)입니다. 한국도 같은 자리(kr_claude 주황).
 */
const EXPOSURE_STYLE: Record<string, { color: string; dashed?: boolean }> = {
  target: { color: BOOK_COLORS.claude, dashed: true },
  actual: { color: BOOK_COLORS.claude },
  [CLAUDE2_EXPOSURE_KEY]: { color: BOOK_COLORS.claude2 },
};

/** 계좌 상세 영역의 id(한 번에 하나만 열림) — 열 때 그 제목으로 포커스를 옮깁니다. */
const ACCOUNT_PANEL_ID = "paper-account-detail";
/** 상세를 닫은 뒤 포커스를 둘 '상세 열기' 단추의 id(상세가 있던 자리 — 옆 칸·대화상자 모두). */
const ACCOUNT_OPEN_ID = "paper-account-detail-open";
/** 좁은 화면(md 미만) — 계좌 표를 계좌·순자산 두 칸의 두 줄 행으로(매크로 지표 표와 같은 경계 — 2026-11-17 결정 9). */
const NARROW_TABLE_MEDIA = "(width < 48rem)";

/**
 * 개요 탭(설계서 §7 — 작업대 P6 재배치, 실행 명세 §7-1 '개요') — 맨 위 KPI 띠(고른 계좌 하나의 순자산·수익률·변화·노출 — 기본은 규칙 계좌, 줄 단추·머리의
 * 계좌 고르기로 바꿈), 시작 카드들, '계좌' 패널(계좌 표 — 줄 = 계좌: 이름 줄 단추·종류·상태 배지·순자산·출발 이후 수익률 칩·노출, 넓은 화면은 오른쪽 검사 칸
 * (InspectorFrame wide — 틀 64rem부터 28rem), 좁은 화면·좁은 틀은 위쪽 대화상자: 그 계좌의 곡선 패널·장부 속성, 사용자가 고른 계좌면 상세 — 정의·지금 설정·핵심
 * 숫자·구성·최근 체결, AccountInspector), 장중 시세 카드, 기간별 순자산 곡선(검사 칸 곡선과 같은 기간, 프레임 판 경계 세로선), 계좌 비교 표(예전 카드의 칸 전부 —
 * 상태·종류·출발·처음 현금·순자산·수익률·노출·현금·보유·마지막 관측·가격 없음·통계 일곱 칸·비교 기준, 그 아래 표본 설명), Claude 노출 추이(목표 vs
 * 실제 — 선 색 = 계좌 색), Claude 호출 사용량(오늘·이달·추정 비용 — 상태 응답), 신호 기관(최근
 * 선정), OS 게이트 지표(참고), 장부 관측치 신선도(와 재무 수집 범위 한 줄 — 상태 응답, D28), 작업 기록. 초기화 전이거나 벤치마크가
 * 아직 사후 체결을 기다리면(pendingBackfill) "초기화" 버튼, 규칙 책이 시작 전이면
 * "규칙 계좌 시작" 버튼, Claude 계좌가 시작 전이면 "미리보기"·"Claude 계좌 시작" 버튼(ClaudeStartSection).
 *
 * 숫자는 개요 응답 그대로 그립니다(띠·표의 글은 lib/paperOverview가 bookCard·currentView에서 만듦). 버튼이 성공하면 onChanged(개요 다시 읽기)를
 * 불러 띠·표·곡선을 새 장부로 바꿉니다. 열 때 읽는 것은 개요(부모)·상태·(계좌2 출발 뒤) 계좌2 순자산·장중 시세뿐이고, 계좌 상세는 사용자가 고른 계좌만 읽습니다.
 *
 * 한국(`market` "KR", 2단계 명세 §4-16): 계좌 표·순자산 곡선·비교 표·Claude 노출 추이·사용량은 같은 패턴을 원 단위 정수로 그리고, 미국 전용
 * 카드(초기화·사후 체결 대기·규칙/Claude 계좌 시작·신호 기관·OS 게이트)는 그리지 않습니다 — 한국 네 계좌는 출발일 밤 결정으로 함께 출발하고
 * 13F·게이트 지표가 없습니다. 상태·리스크 점검은 `?market=KR` 경로입니다. 체결 시점 실험 카드는 한국 Claude 계좌2·계좌1의 실행 감사(단계 2c)로 그립니다.
 */
export function OverviewSection({
  overview,
  onChanged,
  onOpenTab,
  market = "US",
}: {
  overview: PaperOverviewResponse;
  onChanged: () => void;
  /** 상세 패널의 "보유·체결 탭에서 전체 보기"·"결정 로그 보기" — 그 탭으로 바꾸며 이 계좌를 미리 고릅니다(page.tsx). */
  onOpenTab?: (tab: "holdings" | "decisions", code: string) => void;
  /** 이 개요의 시장(기본 미국). */
  market?: PaperMarketCode;
}) {
  // 종목 표시 이름(한국 화면 — 사용자 결정 2026-11-02), 모르면 코드 그대로.
  const nameOf = useTickerName();
  const korea = market === "KR";
  const paths = endpoints.paper.market(market);
  // 정기 작업이 꺼져 있는지·설정 버전·Claude 호출 사용량·재무 수집 범위는 개요 응답에 없어 상태 응답에서 읽습니다(실패해도 개요는 그대로).
  const status = useApi<PaperStatusResponse>(paths.status, 60_000);

  const init = useAsyncAction(() => apiPost<PaperInitResult>(paths.init), "초기화하지 못했습니다.");
  // 한국은 `?market=KR` — 한국 장부의 실패 기억을 지우고 같은 관측치를 다시 처리(쉬면 ok:false·dormantReason).
  const risk = useAsyncAction(() => apiPost<PaperKrRiskResult>(paths.runRisk), "리스크 작업을 실행하지 못했습니다.");
  const initElapsed = useElapsedSeconds(init.busy);
  const riskElapsed = useElapsedSeconds(risk.busy);
  // 규칙 책 시작(초기 결정) — 선정·트랙레코드 계산과 사후 체결을 한 번에 하므로 오래 걸릴 수 있어 경과 초를 셉니다.
  const start = useAsyncAction(
    (book: string) => apiPost<PaperInitialDecisionResult>(endpoints.paper.runInitialDecision, { book }),
    "규칙 계좌를 시작하지 못했습니다.",
  );
  const startElapsed = useElapsedSeconds(start.busy);
  const [confirmingStart, setConfirmingStart] = useState(false);
  // 상세를 연 계좌 코드(한 번에 하나 — 사용자가 그 계좌의 줄 단추나 '상세 열기'를 눌렀을 때만). 이 화면은 주소 쿼리를 쓰지 않아 화면 상태로만 둡니다 —
  // 개요를 다시 읽어도 그대로입니다. 상세가 열린 동안만 그 계좌의 보유·체결·설정을 읽습니다.
  const [selected, setSelected] = useState<string | null>(null);
  // 상세를 '상세 닫기'로 닫았으면 그 자리에 생기는 '상세 열기' 단추로 포커스를 옮깁니다(닫은 단추가 사라져 포커스가 body로 떨어지지 않게).
  const reopenFocus = useRef(false);
  const narrow = useMediaQuery(NARROW_TABLE_MEDIA);
  // 순자산 곡선의 기간 — 처음엔 전체. 저장된 기록보다 긴 기간 탭은 그리지 않습니다(lib navRangeKeys). 검사 칸 곡선과 '순자산 곡선' 패널이 함께 씁니다.
  const [navRange, setNavRange] = useState<NavRangeKey>("all");
  // KPI 띠·검사 칸·장중 카드가 보는 계좌 — 계좌 표의 줄 단추를 누르거나 머리의 계좌 고르기로 고르면 그 계좌(상세를 닫아도·개요를 다시 읽어도 남음, 목록에서
  // 사라지면 기본인 규칙 계좌 — lib heroBookCode, 사용자 결정 2026-11-13).
  const [heroPick, setHeroPick] = useState<string | null>(null);
  // 보는 계좌의 실시간 순자산(장중 카드가 실시간 시세로 다시 셈 — 사용자 결정 2026-11-03 — KPI 띠). 표시 전용이고 장부·계좌 표는 그대로.
  const [realtimeNav, setRealtimeNav] = useState<RealtimeNav | null>(null);
  // 옆 검사 칸에서 상세를 열면 초점을 상세 제목으로 옮깁니다 — 초점이 줄 단추에 남으면 다음 Tab이 다른 줄 단추를 돌았습니다(A11Y-1). 상세는 검사 칸 아래쪽에
  // 열립니다 — 연 상세가 보이도록 가까운 쪽으로만 스크롤하고, 움직임 줄이기(prefers-reduced-motion)를 켠 사람에게는 부드러운 스크롤 대신 바로 옮깁니다.
  // 대화상자 배치(좁은 화면·좁은 틀)는 대화상자가 제목으로 포커스를 둡니다(dialogFocus "title") — 그 안의 상세 제목으로 옮기지 않습니다(곡선·속성을 건너뜀).
  useEffect(() => {
    if (!selected) return;
    const title = document.getElementById(accountDetailTitleId(ACCOUNT_PANEL_ID));
    if (!title || title.closest('[role="dialog"]')) return;
    title.focus({ preventScroll: true });
    const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(ACCOUNT_PANEL_ID)?.scrollIntoView?.({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  }, [selected]);
  useEffect(() => {
    if (selected !== null || !reopenFocus.current) return;
    reopenFocus.current = false;
    document.getElementById(ACCOUNT_OPEN_ID)?.focus();
  }, [selected]);

  const runInit = async () => {
    if (await init.run()) onChanged();
  };
  const runRisk = async () => {
    if (await risk.run()) onChanged();
  };
  const runStart = async (book: string) => {
    const ok = await start.run(book);
    // 성공·실패 모두 확인 단계를 닫습니다 — 실패 사유(예: 수집 중)는 아래 경고로 남고, 다시 누르려면 확인을 한 번 더 거칩니다.
    setConfirmingStart(false);
    if (ok) onChanged();
  };

  const books = overview.books ?? [];
  // 계좌 숫자의 기준 시각 — 네 계좌는 같은 리스크 점검에서 함께 평가돼 보통 하나(가장 늦은 것을 적음, 모르면 생략). 지금 값이 없는 옛 응답의 부제에만.
  const observedAt = latestObserved(books);
  // 계좌 행의 지금 값 기준 — 지금 값이면 행마다 단계 표기, 옛 응답이면 null(예전 '장부의 마지막 관측치 기준').
  const accountsBasis = accountsBasisText(books);
  const session = overview.liveSession ?? null;
  const heroCode = heroBookCode(books, heroPick);
  // 줄 단추·'상세 열기' — 그 계좌를 보고(KPI 띠·검사 칸·장중 카드) 상세를 엽니다.
  const openAccount = (code: string) => {
    setSelected(code);
    setHeroPick(code);
  };
  // '상세 닫기' — 상세만 닫고(요약 계좌 그대로) 그 자리의 '상세 열기'로 포커스.
  const closeAccount = () => {
    reopenFocus.current = true;
    setSelected(null);
  };
  // 머리의 계좌 고르기 — 보는 계좌만 바꾸고 상세는 닫습니다(새로 읽지 않음 — 예전 '순자산을 볼 계좌'와 같음).
  const pickAccount = (code: string) => {
    setHeroPick(code);
    setSelected(null);
  };
  // 기간을 고르면 그 기간의 기록만 그립니다(값은 그대로 — 날짜와 계좌별 값을 같은 자리에서 자름).
  const navRanges = navRangeKeys(overview.navSeries);
  const range = allowedRangeKey(navRange, NAV_RANGES, navRanges) ?? "all";
  const navWindow = navSeriesWindow(overview.navSeries, range);
  // KPI 띠·검사 칸 곡선은 시작한 장부(초기화 뒤)에 계좌가 있을 때만 — 장중 시세 카드와 같은 조건.
  const hero = overview.initialized !== false && heroCode ? overviewHeroModel(overview, heroCode, navWindow, market, realtimeNav) : null;
  const heroBook = books.find((book) => book.code === heroCode) ?? null;
  const heroView = heroBook ? currentView(heroBook, { market, session: overview.liveSession ?? null }) : null;
  const kpi = hero && heroView
    ? overviewKpiItems(hero, { pct: heroView.exposurePct, cashLike: marketMeta(market).cashLike, isEstimated: heroView.isEstimated })
    : null;
  const tableRows = accountTableRows(books, { pendingBackfill: overview.pendingBackfill, quotes: overview.quotes ?? null, market, session: overview.liveSession ?? null });
  const rowOf = new Map(tableRows.map((entry) => [entry.code, entry]));
  const accounts = navChart(navWindow, books);
  // 한국은 노출 맞춘 참고선(K40 — 계산만, 계좌 아님)을 같은 축의 긴 점선 계열로 더합니다(출발 전·F2 전 서버면 계열 없음).
  const reference = korea ? withKrReference(accounts.rows, overview.exposureReference) : { rows: accounts.rows, series: [] };
  // 오늘 추정 꼬리(장중 명세 §4 — 표시 전용): 기간 창·참고선 뒤에 계좌마다 마지막 줄 → 오늘 추정 점의 짧은 점선을 붙입니다(참고선·S = 100 카드에는 없음).
  // 그날 순자산 줄이 생기면 서버가 navEstimate를 보내지 않아 사라집니다.
  const chart = withNavEstimateTail({ rows: reference.rows, series: [...accounts.series, ...reference.series] }, overview.navEstimate, books);
  const tailNote = navTailNote(chart.tailDate);
  const referenceNotes = korea ? krReferenceNotes(overview.exposureReference) : null;
  // 하루 움직임이 1달러 미만이면 정수 눈금이 같은 숫자로 반복됩니다 — 축을 조금 펼치고 자릿수를 간격에 맞춥니다(참고선·꼬리도 축 범위에 넣음).
  const navY = navAxis(chart);
  const lineIndex = (key: string) => chart.series.findIndex((line) => line.key === key);
  const series = chart.series.map((line, index) => ({
    ...line,
    // 꼬리는 그 계좌 선의 색(남는 색을 쓰는 계좌도 그 계좌 자리의 색 — 같은 계좌가 같은 색).
    color:
      line.key === KR_REFERENCE_KEY
        ? REFERENCE_COLOR
        : line.tailOf !== undefined
          ? bookColor(line.tailOf, lineIndex(line.tailOf))
          : bookColor(line.key, index),
    // 원 단위 정수 장부 — 툴팁에 없는 소수 자리를 붙이지 않음(미국은 기본 2자리 그대로).
    ...(korea ? { valueDigits: 0 } : {}),
    ...(line.key === KR_REFERENCE_KEY ? { dashed: true } : {}),
  }));
  const quotes = overview.quotes ?? null;
  const staleNames = (quotes?.staleTickers ?? []).map(nameOf);
  // 미국 전용 — 출발일 종가 사후 체결 초기화(한국은 출발 상태 카드가 맡음).
  const prompt = korea ? null : initPrompt(overview);
  const initResult = init.result && (
    <Callout tone={init.result.skipped?.length ? "warn" : "info"}>초기화 — {initResultText(init.result)}</Callout>
  );
  const startPrompt = korea ? null : rulesStartPrompt(overview);
  const startView = start.result ? initialDecisionResultView(start.result) : null;
  const startResult = startView && <Callout tone={startView.tone}>{startView.text}</Callout>;
  const selection = selectedFilersView(overview.selection);
  const hasClaude = books.some((book) => book.kind === "CLAUDE");
  // 미국 Claude 계좌2(체결 시점 실험) — 출발했으면 노출 추이에 계좌2 실제 노출 선(그 순자산 기록)을, 'S = 100 같은 구간'은 출발일을 기준으로.
  const book2 = korea ? undefined : books.find((book) => isTimedBook(book.code));
  const book2Nav = useApi<PaperNavResponse>(book2?.startedOn ? endpoints.paper.nav(book2.code) : null, 60_000);
  const exposure = claudeExposureChart(
    overview.claudeExposureSeries,
    book2?.startedOn && book2Nav.data?.available ? (book2Nav.data.series ?? []) : null,
  );
  const exposureSeries = exposure.series.map((line) => ({ ...line, ...(EXPOSURE_STYLE[line.key] ?? { color: SPARE_COLORS[0] }) }));
  // 한국 카드는 수동 호출 문턱(상한 − 정기 작업 몫 예약)을 함께 — 한국 출발 단추·수동 결정이 그 문턱에서 막힙니다(미국 카드는 그대로).
  const usage = status.data?.available ? apiUsageView(status.data.apiUsage, korea ? { manual: true } : {}) : null;
  // 재무 수집 범위(D28) — 상태 응답에만 있고, 이 필드를 보내지 않는 백엔드면 줄을 그리지 않습니다.
  const fundamentals = status.data?.available ? fundamentalsLine(status.data.fundamentals) : null;
  // 발표·실적 일정(2단계 A, 패킷 1b_calendar) — 재무 줄과 같은 규칙(필드가 없는 백엔드면 그리지 않음).
  const calendar = status.data?.available ? calendarLine(status.data.calendar) : null;
  // 사건 뉴스 RSS(2단계 B, 패킷 11b_events) — 같은 규칙(필드가 없는 백엔드면 그리지 않음).
  const news = status.data?.available ? newsLine(status.data.news) : null;
  // 어닝 서프라이즈(2단계 C, 패킷 8b eps) — 같은 규칙(필드가 없는 백엔드면 그리지 않음).
  const earnings = status.data?.available ? earningsLine(status.data.earnings) : null;
  // 출발한 계좌2의 1분봉 저장본 한 줄(상태 응답 claude2.bars — 정규장일 때만 받은 시각·지연, 시작 전이면 줄 없음).
  const barsLine = !korea && status.data?.available ? claude2BarsLine(status.data.claude2, book2?.label) : null;
  // 그 아래 '오늘 장중 확인' 한 줄(단계 2 — 상태 응답 claude2.checkpoint). 1분봉 줄과 같은 규칙(출발한 계좌2만, 칸이 없는 백엔드면 줄 없음).
  const checkpointLine = barsLine && status.data?.available ? claude2CheckpointLine(status.data.claude2) : null;
  // 장중 스탑 감시 살아 있음 신호(ADR 0032 — 상태 응답 stopWatch, 스위치가 꺼졌으면 칸이 없어 줄 없음).
  const watchLine = status.data?.available ? stopWatchLine(status.data.stopWatch, market) : null;
  // 미국 '장부 관측치' 카드의 출처(한국 개요는 이 카드 대신 한국 수집 상태 카드 — 출처를 그 카드가 적음).
  const observationSource = [
    PAPER_SOURCES.quotes,
    barsLine ? `1분봉: ${PAPER_SOURCES.bars}` : null,
    fundamentals ? `재무: ${PAPER_SOURCES.fundamentals}` : null,
    calendar ? `일정: ${PAPER_SOURCES.calendar}` : null,
    news ? `사건 뉴스: ${PAPER_SOURCES.news}` : null,
    earnings ? `어닝 서프라이즈: ${PAPER_SOURCES.earnings}` : null,
  ].filter(Boolean).join(" · ");
  // 판 경계는 Claude 책에만 뜻이 있습니다(프레임은 규칙 책에 영향 없음, 명세 F5) — 그래도 네 책 곡선 위에 그려 같은 날 무엇이 바뀌었는지 봅니다.
  // 한 줄 글은 전체 기록 기준(기간 밖의 경계를 '그날 기록 없음'으로 적지 않게), 세로선은 고른 기간 안의 날짜만.
  const boundaries = frameworkBoundaryView(overview.frameworkBoundaries, overview.navSeries?.dates ?? []);
  const markers = markersInWindow(boundaries.markers, navWindow);
  const ledgerSource = korea ? PAPER_SOURCES.krLedger : PAPER_SOURCES.ledger;

  return (
    <>
      {status.data?.available && status.data.enabled === false && (
        <Callout tone="warn">
          정기 작업이 꺼져 있습니다(<code>PAPER_ENABLED=false</code>) —{" "}
          {korea && overview.initialized === false
            // 한국 계좌가 없으면 '리스크 지금 실행' 단추도 없습니다(화면 확인 — 없는 단추를 가리키지 않게).
            ? "한국 리스크 점검·결정·출발도 정기적으로 돌지 않습니다."
            : <>리스크 작업(체결·스탑·평가)은 아래 &quot;리스크 지금 실행&quot;을 누를 때만 돕니다.</>}
        </Callout>
      )}
      {/* 상태를 읽지 못하면 꺼짐·켜짐을 모릅니다 — 배너가 조용히 사라지면 켜져 있는 것으로 읽히므로 그렇다고 적습니다(홈과 같은 문구). */}
      {status.error && <Callout tone="warn">정기 작업 상태를 확인하지 못했습니다 — {status.error}</Callout>}

      {/* 머리의 계좌 고르기(PaperTabHeader 칸) — KPI 띠·검사 칸·장중 카드가 보는 계좌. 시작한 장부에만(예전 히어로의 '순자산을 볼 계좌'와 같은 조건). */}
      {hero && (
        <PaperTabAccount value={hero.code} options={books.map((book) => ({ value: book.code, label: book.label }))} onChange={pickAccount} />
      )}
      {/* KPI 띠(작업대 W7 — 44px 히어로를 대신함) — 고른 계좌의 순자산·수익률·변화·노출(추정·이전 값 배지·출처 줄). 곡선과 문지르기는 계좌 표의 검사 칸. */}
      {kpi && hero && <KpiStrip label={`${hero.name} 요약`} items={kpi} />}

      {prompt && (
        <Panel title={prompt.title} source={PAPER_SOURCES.ledger}>
          <p className="text-sm leading-relaxed text-text-2">{prompt.body}</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={() => void runInit()} disabled={init.busy}>
              {init.busy ? `초기화 중… ${initElapsed}초` : "초기화"}
            </Button>
          </div>
          {init.error && <div className="mt-3"><Callout tone="warn">{init.error}</Callout></div>}
          {/* 종가가 없어 건너뛴 벤치마크의 서버 사유는 다시 누를 버튼 바로 아래에 둡니다. */}
          {initResult && <div className="mt-3">{initResult}</div>}
        </Panel>
      )}
      {/* 카드가 사라진 뒤(모두 시작함)에도 초기화 결과는 남겨 둡니다 — 무엇을 만들고 체결했는지 읽을 수 있게. */}
      {!prompt && initResult}

      {startPrompt && (
        <Panel title={startPrompt.title} subtitle="초기 결정 — 출발일 종가 사후 체결" source={PAPER_SOURCES.decisions}>
          <p className="text-sm leading-relaxed text-text-2">{startPrompt.body}</p>
          {confirmingStart ? (
            <div className="mt-3 flex flex-col gap-3 rounded-control border border-warn/30 bg-warn-tint px-3 py-3">
              <p className="text-sm leading-relaxed text-warn">{startPrompt.confirm}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" onClick={() => void runStart(startPrompt.bookCode)} disabled={start.busy}>
                  {start.busy ? `시작 중… ${startElapsed}초` : "시작 확인"}
                </Button>
                <Button onClick={() => setConfirmingStart(false)} disabled={start.busy}>취소</Button>
              </div>
            </div>
          ) : (
            <div className="mt-3">
              <Button variant="primary" onClick={() => setConfirmingStart(true)} disabled={start.busy}>{startPrompt.title}</Button>
            </div>
          )}
          {/* 서버의 400 문구(트랙레코드 수집 중·이미 시작함 등)를 그대로 — 무엇을 기다려야 하는지 서버가 적어 보냅니다. */}
          {start.error && <div className="mt-3"><Callout tone="warn">{start.error}</Callout></div>}
          {startResult && <div className="mt-3">{startResult}</div>}
        </Panel>
      )}
      {/* 시작한 뒤(개요를 다시 읽어 카드가 사라짐)에도 결과는 남깁니다 — 주문·사후 체결 수를 읽을 수 있게. */}
      {!startPrompt && startResult}

      {!korea && <ClaudeStartSection overview={overview} onChanged={onChanged} />}
      {/* 상태를 아직 기다리는 중(앞서 받은 값 없음)과 실패를 갈라 넘깁니다 — 실패만 '읽지 못해'(QA-149). 값이 있는 다시 읽기의 실패는
          카드에 '새로 읽지 못함'(QA-151). */}
      {!korea && (
        <Claude2StartSection
          overview={overview}
          status={status.data ?? null}
          statusPending={status.loading && status.data === null}
          statusRefreshError={status.refreshError}
          onChanged={onChanged}
        />
      )}
      {korea && <KrStartSection overview={overview} status={status.data ?? null} onChanged={onChanged} />}

      <Panel
        title="계좌"
        count={books.length > 0 ? `${books.length}개` : undefined}
        subtitle={
          <>
            {`순자산·수익률(출발 이후)은 ${accountsBasis ?? `장부의 마지막 관측치 기준${observedAt ? `(${observedAt} KST)` : ""}`} · 계좌 이름을 누르면 그 계좌의 곡선·상세${
              hero ? "(위 요약·아래 장중 시세도 그 계좌로)" : ""
            }`}
            {korea && overview.initialized !== false ? ` · ${KR_RISK_RUN_NOTE}` : ""}
            <SettingsVersionTail version={status.data?.settingsVersion ?? null} />
          </>
        }
        source={ledgerSource}
        actions={
          overview.initialized !== false && (
            <Button onClick={() => void runRisk()} disabled={risk.busy}>
              {risk.busy ? `실행 중… ${riskElapsed}초` : "리스크 지금 실행"}
            </Button>
          )
        }
      >
        {risk.error && <div className="mb-3"><Callout tone="warn">{risk.error}</Callout></div>}
        {risk.result && (
          <div className="mb-3"><RiskResult view={korea ? krRiskResultView(risk.result) : riskResultView(risk.result)} /></div>
        )}
        {books.length === 0 ? (
          <p className="text-sm text-text-3">
            {korea
              ? "한국 계좌가 없습니다 — 한국 초기화를 하면 네 계좌가 현금만 든 '시작 전'으로 생깁니다(쉬는 사유는 화면 위)."
              : "계좌가 없습니다. 초기화하면 생깁니다."}
          </p>
        ) : (
          // 계좌 표 + 검사 칸(작업대 P6 — 명세 §7-1 '개요: 계좌 비교 표 + 고른 계좌 검사 칸'). 틀 64rem부터 옆 28rem 칸, 그 아래·좁은 화면은 위쪽 대화상자.
          // 검사 칸이 보는 계좌는 늘 KPI 띠의 계좌(기본 규칙 계좌) — 상세(정의·구성·최근 체결 — 읽기)는 사용자가 고른 계좌만.
          <InspectorFrame
            label="계좌 자세히"
            layout="wide"
            dialogFocus="title"
            titleOf={(code) => books.find((book) => book.code === code)?.label ?? null}
            selectedKey={heroCode}
            onSelectedKeyChange={(code) => {
              // 옆 칸의 Esc(고름 풀기)는 상세만 닫습니다 — 보는 계좌는 그대로(검사 칸 틀이 그 줄 단추로 포커스를 옮김).
              if (code === null) setSelected(null);
              else setHeroPick(code);
            }}
            renderDetail={(code) => {
              const book = books.find((entry) => entry.code === code);
              if (!book) return null;
              return (
                <AccountInspector
                  book={book}
                  books={books}
                  row={rowOf.get(code) ?? null}
                  model={hero && hero.code === code ? hero : overview.initialized !== false ? overviewHeroModel(overview, code, navWindow, market, realtimeNav) : null}
                  range={range}
                  ranges={navRanges}
                  onRange={setNavRange}
                  detail={selected === code}
                  detailId={ACCOUNT_PANEL_ID}
                  openId={ACCOUNT_OPEN_ID}
                  onOpenDetail={() => openAccount(code)}
                  onCloseDetail={closeAccount}
                  onOpenTab={onOpenTab}
                  market={market}
                  session={session}
                />
              );
            }}
          >
            {(inspector) => (
              <DataTable<AccountTableRow>
                columns={accountColumns(inspector, openAccount, narrow, books)}
                rows={tableRows}
                rowKey={(row) => row.code}
                caption="계좌 목록"
                selectedKey={inspector.shownKey}
              />
            )}
          </InspectorFrame>
        )}
      </Panel>

      {/* 장중 시세(표시 전용 추정) — 장 상태·간격·출처와 보는 계좌의 종목 장중가(계좌 고르기는 계좌 표·머리). 새 장중 값을 받으면 개요를
          한 번 다시 읽습니다(onChanged — KPI 띠·계좌 표의 지금 값은 서버가 같은 장중 저장본을 합친 값). */}
      {overview.initialized !== false && books.length > 0 && (
        <LiveValuationCard market={market} bookCode={heroCode} onUpdated={onChanged} onRealtime={setRealtimeNav} />
      )}

      <Panel
        title="순자산 곡선"
        subtitle={`${korea ? "KR 거래일" : "거래일"}별 순자산(${marketMeta(market).unitLabel}). 그날 기록이 없는 계좌는 선을 끊어 그립니다 — 시작 전인 계좌는 선이 없습니다.${
          hero && navRanges.length > 1 ? " 기간은 계좌 검사 칸의 곡선과 함께 바뀝니다." : ""
        }`}
        // 꼬리가 있으면 그 점의 출처(보유를 장중 1분봉으로 다시 평가한 표시 전용 추정 — 계좌 표·KPI 띠의 지금 값과 같은 글)를 함께.
        source={[tailNote ? currentSource(true, market) : ledgerSource, boundaries.text ? `프레임 경계는 ${PAPER_SOURCES.boundaries}` : null]
          .filter(Boolean)
          .join(" · ")}
        actions={
          // 기간 탭 — 계좌 검사 칸의 곡선과 같은 기간 상태(작업대 P6 — 예전 히어로가 지니던 탭). 기간이 '전체' 하나뿐이면(출발 직후) 탭을 그리지
          // 않습니다 — 고를 것이 없는 탭은 소음입니다.
          navRanges.length > 1 && (
            <RangeTabs ranges={NAV_RANGES} allowed={navRanges} value={range} onChange={setNavRange} label="순자산 곡선 기간" />
          )
        }
      >
        <MultiLineSeries
          data={chart.rows}
          series={series}
          precision={navY.precision}
          domain={navY.domain}
          height={300}
          markers={markers}
          ariaLabel="순자산 곡선"
          // 툴팁은 그 날 순자산이 큰 차례로, 글자는 선 색으로(2026-11-18 사용자 요구 — 기본은 이름 차례·본문색). 미국·한국이 같은 카드라 둘 다.
          tooltipOrder="value"
          tooltipSeriesColors
          // 원 단위 정수 눈금("100,000,000")은 기본 폭(64px)에서 잘립니다 — 한국만 넓힙니다.
          axisWidth={korea ? 84 : undefined}
        />
        {tailNote && <p className="mt-2 text-xs text-text-3">{tailNote}</p>}
        {boundaries.text && <p className="mt-2 text-xs text-text-3">{boundaries.text}</p>}
        {/* 규칙 계좌 결과는 종목 신호와 주식 노출이 섞인 값 — 미국(남는 현금 SHY)·한국(153130, 참고선과 함께) 같은 함수(2단계 명세 §4-16). */}
        <p className="mt-2 text-xs text-text-3">{exposureNote(market)}</p>
        {referenceNotes && (
          <ul aria-label="노출 맞춘 참고선 설명" className="mt-2 flex flex-col gap-0.5 text-xs text-text-3">
            {referenceNotes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        )}
      </Panel>

      {books.length > 0 && <AccountComparisonCard books={books} market={market} session={session} />}

      {!korea && book2 && <SameWindowCard overview={overview} books={books} />}

      {hasClaude && (
        <Panel
          title="Claude 노출 추이"
          subtitle={`목표 = Claude가 결정마다 정한 주식 노출(기록·표시용 — 집행은 주문 기준) · 실제 = 그 거래일 장부의 주식 노출${
            exposure.series.some((line) => line.key === CLAUDE2_EXPOSURE_KEY)
              ? "(목표·실제는 계좌1) · 계좌2 실제 = Claude 계좌2 장부의 주식 노출"
              : ""
          }. 기록이 없는 날은 선을 끊어 그립니다.`}
          source={PAPER_SOURCES.exposure}
        >
          {exposure.rows.length === 0 ? (
            <p className="text-sm text-text-3">
              {korea
                ? "아직 한국 Claude 결정 기록이 없습니다 — 한국 네 계좌가 출발하면 결정마다 정한 목표 노출과 그 KR 거래일의 실제 노출을 그립니다."
                : "아직 Claude 결정 기록이 없습니다 — Claude 계좌를 시작하면 결정마다 정한 목표 노출과 그 거래일의 실제 노출을 그립니다."}
            </p>
          ) : (
            <>
              <MultiLineSeries
                data={exposure.rows}
                series={exposureSeries}
                unit="%"
                precision={0}
                height={240}
                domain={[0, 100]}
                ariaLabel="Claude 노출 추이(목표 대비 실제)"
              />
              {exposure.latest && <p className="mt-2 text-xs text-text-3">마지막 {exposure.latest}</p>}
            </>
          )}
        </Panel>
      )}

      {hasClaude && <ExecutionExperimentCard books={books} market={market} />}

      {hasClaude && usage && (
        <Panel
          title="Claude 호출 사용량"
          subtitle={korea
            ? "결정·출발·재시도·프레임 제안·복기의 호출 수·토큰·추정 비용(KST 날짜 기준) — 하루 상한은 미국·한국 계좌가 함께 쓰고, 수동 호출은 정기 작업 몫을 남긴 문턱까지입니다"
            : "결정·미리보기·시작·재시도·프레임 제안의 호출 수·토큰·추정 비용(KST 날짜 기준) — 하루 상한에 닿으면 그날은 Claude를 부르지 않습니다"}
          source={PAPER_SOURCES.apiUsage}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <UsageCells label={usage.todayLabel} cells={usage.today} />
            <UsageCells label={usage.monthLabel} cells={usage.month} />
          </div>
          {usage.capReached && (
            <p className="mt-2 text-xs text-warn">오늘 호출이 하루 상한에 닿았습니다 — 오늘 남은 결정은 Claude를 부르지 않고 건너뛰고, 미리보기·프레임 제안도 서버가 거절합니다.</p>
          )}
          {!usage.capReached && usage.manualReached && (
            <p className="mt-2 text-xs text-warn">
              오늘 호출이 수동 호출 문턱에 닿았습니다 — 수동 호출(미리보기·시작·수동 결정·프레임 제안·수동 복기·한국 출발 단추)은 서버가 거절하고,
              정기 작업은 하루 상한까지 부릅니다.
            </p>
          )}
          <p className="mt-2 text-xs text-text-3">{usage.costNote}</p>
          {usage.note && <p className="mt-1 text-xs text-text-3">{usage.note}</p>}
        </Panel>
      )}

      {/* 한 칸일 때도 grid-cols-1(minmax(0, 1fr)) — 칸 수를 주지 않으면 auto 칸이 안쪽 표(최소 640px)만큼 늘어나 390px에서 두 카드가 화면 밖으로 잘렸습니다. */}
      {!korea && (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel
          title="신호 기관"
          subtitle={selection
            ? `${selection.asOfDate} 선정 — 규칙 계좌가 두 그룹을 합친 신호 풀의 13F 변화를 신호로 씁니다(다음 재선정일까지)`
            : "규칙 계좌가 13F 신호를 읽는 기관(그룹 A: 후보 트랙레코드 상위 · 그룹 B: 기존 13F 메뉴 최근 상위)"}
          source={PAPER_SOURCES.selection}
        >
          {!selection ? (
            <p className="text-sm text-text-3">아직 기관 선정이 없습니다 — 규칙 계좌를 시작하면 출발일 기준으로 선정하고, 그 뒤는 재선정일마다 다시 뽑습니다.</p>
          ) : selection.groupA.length === 0 && selection.pool.length === 0 ? (
            <p className="text-sm text-text-3">선정이 비어 있습니다 — 자격 있는 기관이 없었습니다(규칙 계좌는 매수 없이 SHY만 듭니다).</p>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <GroupList
                  title="그룹 A — 후보 기관 트랙레코드 상위"
                  rows={selection.groupA}
                  empty="자격 있는 기관이 없습니다."
                />
                <GroupList
                  title="그룹 B — 기존 13F 메뉴 최근 상위"
                  rows={selection.groupB}
                  empty="자격 있는 기관이 없습니다 — 신호는 그룹 A만 냅니다(가중은 그룹 A가 전부)."
                />
              </div>
              {selection.pool.length > 0 && (
                <section aria-label="신호 풀" className="flex flex-col gap-1">
                  <h3 className="text-xs font-semibold text-text">신호 풀 · 기관 가중</h3>
                  {/* 공용 조밀 표(작업대 P6 통합 — 옛 ui Table). 네 칸이라 최소 폭·넘김 안내 없이 카드 폭에 맞춤(결정 상세 표와 같은 규칙 — 다섯 칸 이상만 640px),
                      모르는 그룹·순위·가중은 공용 '—'(낭독 '값 없음'). */}
                  <DataTable<PoolRow>
                    caption="신호 풀"
                    dense
                    rows={selection.pool}
                    rowKey={(row) => row.key}
                    columns={[
                      { key: "name", header: "기관", className: "break-keep", cell: (row) => <span className="font-semibold text-text">{row.name}</span> },
                      { key: "group", header: "그룹", cell: (row) => (row.group ? <GroupBadge badge={row.group} /> : null) },
                      { key: "ranks", header: "순위", cell: (row) => (row.ranks === EMPTY ? null : <span className="whitespace-nowrap">{row.ranks}</span>) },
                      { key: "weight", header: "기관 가중", align: "right", cell: (row) => row.weight },
                    ]}
                  />
                </section>
              )}
            </div>
          )}
        </Panel>

        <Panel title="OS 게이트 지표" subtitle="참고 — 구속하지 않음 · 과거 OS가 쓴 매크로 트리거 수준" source={PAPER_SOURCES.gate}>
          <GateIndicatorBody gate={overview.gate} />
        </Panel>
      </div>
      )}

      {korea ? (
        <KrCollectionCard status={status} quotes={quotes} />
      ) : (
        <Panel
          title="장부 관측치"
          subtitle="체결·스탑·평가에 쓰는 저장본입니다. 장중이면 마지막 봉이 지연 시세입니다."
          source={observationSource}
          actions={
            quotes && (
              <Freshness collectedAt={quotes.collectedAtKst} ageSeconds={quotes.ageSeconds ?? undefined} stale={quotes.stale} />
            )
          }
        >
          <p className="text-sm text-text-2">{quotesLine(quotes)}</p>
          {staleNames.length > 0 && (
            <p className="mt-1 text-xs text-warn">지난 값을 이어 쓴 티커: {staleNames.join(", ")}</p>
          )}
          {barsLine && <p className="mt-1 text-xs text-text-3">{barsLine}</p>}
          {checkpointLine && <p aria-label="오늘 장중 확인" className="mt-1 text-xs text-text-3">{checkpointLine}</p>}
          {fundamentals && <p className="mt-1 text-xs text-text-3">{fundamentals}</p>}
          {calendar && <p className="mt-1 text-xs text-text-3">{calendar}</p>}
          {news && <p className="mt-1 text-xs text-text-3">{news}</p>}
          {earnings && <p className="mt-1 text-xs text-text-3">{earnings}</p>}
        </Panel>
      )}

      <Panel title="작업 기록" subtitle={jobsCardSubtitle(market)} source={PAPER_SOURCES.jobs}>
        {watchLine && <p aria-label="장중 스탑 감시" className="mb-2 text-xs text-text-3">{watchLine}</p>}
        <DataTable<PaperJobRun & { key: string }>
          caption="작업 기록"
          dense
          count={(count) => `${count}건`}
          scrollHint="overflow"
          // 미국 개요 응답의 작업 기록은 한국 kr.* 줄도 담아(미국 응답 글자 그대로 — x3) 화면에서 그 시장 줄만 남깁니다.
          rows={marketJobs(overview.jobs, market).map((row, index) => ({ ...row, key: `${row.job}-${row.startedAtKst ?? index}-${index}` }))}
          rowKey={(row) => row.key}
          emptyText={jobsEmptyMessage(market, overview.jobs)}
          columns={[
            { key: "job", header: "작업", cell: (row) => row.job },
            { key: "startedAt", header: "시작", cell: (row) => formatKst(row.startedAtKst) },
            { key: "finishedAt", header: "끝", cell: (row) => formatKst(row.finishedAtKst) },
            {
              key: "outcome",
              header: "결과",
              cell: (row) => <span className={jobOutcomeClass(row.outcome)}>{row.outcome || EMPTY}</span>,
            },
            {
              key: "detail",
              header: "상세",
              cell: (row) => (
                <span className="text-xs text-text-3" title={jsonTitle(row.detail)}>
                  {korea ? krJobDetailText(row) : jsonSummary(row.detail)}
                </span>
              ),
            },
          ]}
        />
      </Panel>
    </>
  );
}

/**
 * "S = 100 같은 구간"(계좌2 명세 §4-2의 2·§13-3) — 계좌2 출발일 S를 기준일로 계좌1·계좌2·SPY 계좌의 순자산을 100에 맞춘 선(서술용 — 판정은
 * '체결 시점 실험'의 주문 단위 반사실). 계좌2가 출발하기 전이면 그렇다고 적고 그리지 않습니다(S 이전 구간은 계좌2 값이 없어 100으로 채우지 않음).
 */
function SameWindowCard({ overview, books }: { overview: PaperOverviewResponse; books: readonly PaperBookSummary[] }) {
  const view = sameWindowIndex(overview.navSeries, books);
  const series = (view?.series ?? []).map((line, index) => ({
    ...line,
    color: bookColor(line.key, index),
  }));
  return (
    <Panel
      title="S = 100 같은 구간"
      subtitle={view
        ? `기준일 S = ${view.baseDate}(Claude 계좌2 출발일)의 순자산을 100으로 — 계좌1·계좌2·SPY 계좌가 같은 구간을 겪은 결과(서술용, 판정에 쓰지 않음). S 이전 계좌2 값은 없습니다(—).`
        : "Claude 계좌2가 출발하면 그 출발일 S의 순자산을 100으로 맞춰 계좌1·계좌2·SPY 계좌를 같은 구간에서 나란히 그립니다(서술용, 판정에 쓰지 않음)."}
      source={PAPER_SOURCES.sameWindow}
    >
      {!view ? (
        <p className="text-sm text-text-3">아직 계좌2가 출발하지 않았습니다 — 출발 전 구간은 계좌2 값이 없어(—) 그리지 않습니다.</p>
      ) : (
        <>
          <MultiLineSeries data={view.rows} series={series} precision={1} height={240} ariaLabel="S = 100 같은 구간" />
          {view.latest && <p className="mt-2 text-xs text-text-3">마지막 {view.latest}</p>}
          {view.missingBase.length > 0 && (
            <p className="mt-1 text-xs text-warn">기준일에 순자산 기록이 없어 선을 그리지 않은 계좌: {view.missingBase.join(", ")}</p>
          )}
        </>
      )}
    </Panel>
  );
}

/**
 * 리스크 작업 결과. ok:false(한 책이 오류로 되돌려짐)면 경고 배너에 오류를, 성공이든 아니든 처리 메모를 목록으로 보입니다 —
 * HTTP 200이라 버튼은 성공으로 끝나므로, 응답의 ok를 보지 않으면 실패가 정상 완료 문구로 보였습니다.
 */
function RiskResult({ view }: { view: RiskResultView }) {
  return (
    <Callout tone={view.tone}>
      {view.warning && <p className="font-semibold">{view.warning}</p>}
      <p className="text-xs">리스크 작업 — {view.summary}</p>
      {view.errors.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-semibold">오류</p>
          <ul aria-label="리스크 작업 오류" className="list-disc pl-5 text-xs">
            {view.errors.map((error, index) => <li key={`${index}-${error}`}>{error}</li>)}
          </ul>
        </div>
      )}
      {view.notes.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-semibold">처리 메모</p>
          <ul aria-label="리스크 작업 메모" className="list-disc pl-5 text-xs">
            {view.notes.map((note, index) => <li key={`${index}-${note}`}>{note}</li>)}
          </ul>
        </div>
      )}
    </Callout>
  );
}

/** 사용량 칸 묶음 하나(오늘·이달). */
function UsageCells({ label, cells }: { label: string; cells: readonly { key: string; label: string; value: string }[] }) {
  return (
    <section aria-label={`Claude 호출 사용량 ${label}`} className="flex flex-col gap-1">
      <h3 className="text-xs font-semibold text-text">{label}</h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
        {cells.map((cell) => (
          <Cell key={cell.key} label={cell.label} value={cell.value} small />
        ))}
      </dl>
    </section>
  );
}

/** 선정 그룹 하나의 목록 — 그룹 안 순위 순(서버 순서), 이름을 모르면 CIK. */
function GroupList({ title, rows, empty }: { title: string; rows: SelectedFilerRow[]; empty: string }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h3 className="text-xs font-semibold text-text">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-text-3">{empty}</p>
      ) : (
        <ol className="space-y-0.5 text-xs text-text-2">
          {rows.map((row) => (
            <li key={row.key} title={`CIK ${row.cik}`}>
              <span className="tabular-nums text-text-3">{row.rank}</span> <span>{row.name}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** 그룹 배지 — 공용 태그(PaperBadge — 20px, 마우스 설명 그대로). */
function GroupBadge({ badge }: { badge: Badge }) {
  return <PaperBadge badge={badge} />;
}


function Cell({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-text-3">{label}</dt>
      <dd className={`tabular-nums text-text ${small ? "text-xs" : "text-sm font-semibold"}`}>{value}</dd>
    </div>
  );
}

/**
 * 계좌 표의 칸(작업대 P6 — 예전 계좌 행 AssetRow의 칸을 표로): 계좌(행 머리 — 곡선 색 견본(장식)·줄 단추 '{계좌} 상세 보기'(보이는 글은 계좌 이름 — 누르면 그 계좌를
 * 보고 상세를 엶)·종류와 상태 배지·경고) · 순자산(값·단위, 둘째 줄 값의 기준 한 줄과 추정·이전 값 배지) · 수익률(출발 이후 — 변화 칩: ▲▼·부호·낭독 글) · 주식 노출.
 * 좁은 화면(md 미만)은 계좌·순자산 두 칸이고 순자산 칸 둘째 줄에 수익률 칩·배지를 둡니다(기준 한 줄·노출은 검사 대화상자의 KPI·속성 — 매크로 지표 표와 같은 결정 9).
 */
function accountColumns(
  inspector: InspectorContext,
  onOpen: (code: string) => void,
  narrow: boolean,
  books: readonly PaperBookSummary[],
): Column<AccountTableRow>[] {
  const colorOf = (code: string) => bookColor(code, books.findIndex((book) => book.code === code));
  const account: Column<AccountTableRow> = {
    key: "account",
    header: "계좌",
    rowHeader: true,
    cell: (row) => {
      const props = inspector.triggerProps(row.code);
      return (
        <span className="flex min-w-[8rem] flex-col items-start gap-0.5">
          <span className="flex items-center gap-2">
            {/* 곡선 색 견본 — 장식(뜻은 이름이 나름), 고대비에서도 계열 색 그대로. */}
            <span aria-hidden="true" className="inline-block size-2.5 shrink-0 rounded-[2px] forced-color-adjust-none" style={{ backgroundColor: colorOf(row.code) }} />
            <button
              type="button"
              {...props}
              onClick={(event) => {
                // 그 계좌를 보고 상세를 연 뒤 틀의 처리(옆 칸이면 고름, 아니면 대화상자) — 좁은 틀에서도 누르면 상세를 읽습니다(예전 행 누르기와 같음).
                onOpen(row.code);
                props.onClick(event);
              }}
              className={`${ROW_TRIGGER} font-semibold`}
            >
              {row.label}{" "}
              <span className="sr-only">상세 보기</span>
            </button>
          </span>
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-text-3">
            <span>{row.kind}</span>
            <PaperBadge badge={row.status} />
          </span>
          {row.warning ? (
            <span className="text-xs text-warn">
              <StatusText tone="warn" icon={<AlertTriangleIcon size={12} />}>
                {row.warning}
              </StatusText>
            </span>
          ) : null}
        </span>
      );
    },
  };
  const nav: Column<AccountTableRow> = {
    key: "nav",
    header: "순자산",
    align: "right",
    cell: (row) => (
      <span className="flex flex-col items-end gap-0.5">
        {row.navText === EMPTY ? (
          <span className="text-text-3">
            <Empty align="end" />
          </span>
        ) : (
          <span className="whitespace-nowrap">
            <span className="font-semibold text-text">{row.navText}</span> <span className="text-xs text-text-3">{row.unit}</span>
          </span>
        )}
        {/* 좁은 표(두 칸)는 수익률 칸이 없어 이 칸 둘째 줄에 — 무엇의 변화인지 이름('출발 이후')을 붙이고, 모르면 넓은 칸처럼 '—'(QA-775). */}
        {narrow ? (
          <span className="flex flex-wrap items-baseline justify-end gap-x-1">
            <span className="text-xs text-text-3">출발 이후</span>
            {row.returnPct === null ? (
              <span className="text-xs text-text-3">
                <Empty align="end" />
              </span>
            ) : (
              <ChangeChip size="sm" changePct={row.returnPct} />
            )}
          </span>
        ) : null}
        {/* 기준 한 줄·배지는 오른쪽 정렬 칸의 줄바꿈 없음을 풀어 낱말 사이에서 접습니다(최대 16rem) — 그러지 않으면 1440 옆 검사 칸 배치에서 이전 값 사유가
            한 줄로 늘어 표가 상자보다 넓어지고 오른쪽 칸(주식 노출)이 가로 넘김 밖으로 갔습니다(자기 빌드 — 표 749px · 상자 662px). */}
        {!narrow && row.caption ? <span className="max-w-[16rem] whitespace-normal break-keep text-xs text-text-3">{row.caption}</span> : null}
        {row.isEstimated || row.isStale ? (
          <span className="flex max-w-[16rem] flex-wrap justify-end gap-1 whitespace-normal">
            <EstimateBadge estimated={row.isEstimated} />
            <StaleBadge stale={row.isStale} reason={row.staleReason} />
          </span>
        ) : null}
      </span>
    ),
  };
  if (narrow) return [account, nav];
  return [
    account,
    nav,
    {
      key: "return",
      header: "수익률(출발 이후)",
      align: "right",
      cell: (row) => (row.returnPct === null ? (
        <span className="text-text-3">
          <Empty align="end" />
        </span>
      ) : (
        <ChangeChip size="sm" changePct={row.returnPct} />
      )),
    },
    { key: "exposure", header: "주식 노출", align: "right", cell: (row) => row.exposureText },
  ];
}

/**
 * 설정 판 번호 자리(세 자리 — 운영 판 번호는 v29이고 하루 약 한 판이라 세 자리까지 잡아 둡니다, 두 자리였을 때 v100에서 부제가 한 글자 넓어져 1328~1334 CLS
 * 0.226 — QA-820). 채운 글자는 보이지 않고 읽히지 않습니다(aria-hidden).
 */
const SETTINGS_VERSION_DIGITS = 3;

/**
 * 계좌 패널 부제 맨 끝의 ' · 설정 v{n}'. 상태 응답은 개요보다 늦게 올 수 있어, 판 번호가 없을 때(읽는 동안·읽기 실패·번호 없음)는 같은 꼴의 보이지 않는
 * 자리(' · 설정 v000')를 두고, 온 뒤에는 판 번호가 세 자리보다 짧으면 모자란 자리를 보이지 않는 '0'으로 채웁니다 — 부제 폭이 상태 응답 전후로 같아야 패널
 * 머리(공용 Panel — flex-wrap justify-between)가 '리스크 지금 실행'을 다음 줄로 보냈다 되돌리며 계좌 표를 밀지 않습니다(QA-811 — 1280 첫 적재 CLS 0.215).
 * 읽기에 실패하거나 판 번호가 없을 때도 자리를 남깁니다 — 예전처럼 지우면 부제가 짧아지며 동작이 제목 줄로 돌아와 계좌 표를 끌어올렸습니다(QA-820 — 실패
 * 0.39·번호 없음 0.21). 부제 맨 끝이라(한국은 리스크 실행 안내 뒤) 자리가 문장 가운데 빈틈으로 남지 않고 판 번호가 와도 뒤 글이 다시 흐르지 않습니다.
 * 판 번호 글은 부제 글과 같은 글 마디(span 없이)라 낭독·글자 찾기는 예전 그대로입니다.
 */
function SettingsVersionTail({ version }: { version: number | null }) {
  if (version) {
    const pad = Math.max(0, SETTINGS_VERSION_DIGITS - String(version).length);
    return (
      <>
        {` · 설정 v${version}`}
        {pad > 0 ? <span aria-hidden="true" className="invisible">{"0".repeat(pad)}</span> : null}
      </>
    );
  }
  return <span aria-hidden="true" className="invisible">{` · 설정 v${"0".repeat(SETTINGS_VERSION_DIGITS)}`}</span>;
}
