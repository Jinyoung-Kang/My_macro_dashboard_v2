"use client";

import { type ReactNode, useEffect, useState } from "react";
import { MultiLineSeries, SERIES_COLORS } from "@/components/charts";
import { AssetRow, type Column, DataTable, RangeTabs } from "@/components/patterns";
import { Banner, Button, Card, Freshness, Table } from "@/components/ui";
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
  accountComparisonRows,
  bookAssetRow,
  latestObserved,
  type ComparisonRow,
  markersInWindow,
  NAV_RANGES,
  type NavRangeKey,
  navRangeKeys,
  navSeriesWindow,
  sameWindowIndex,
  sampleNotes,
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
import { AccountDetailPanel, accountDetailTitleId } from "./AccountDetailPanel";
import { Claude2StartSection } from "./Claude2StartSection";
import { ClaudeStartSection } from "./ClaudeStartSection";
import { ExecutionExperimentCard } from "./ExecutionExperimentCard";
import { GateIndicatorBody } from "./GateIndicatorBody";
import { KrCollectionCard } from "./KrCollectionCard";
import { KrStartSection } from "./KrStartSection";
import { LiveValuationCard } from "./LiveValuationCard";

/**
 * 책 코드별 선 색. 앞 셋은 charts의 검증된 팔레트, 혼합 벤치마크는 회색입니다
 * (벤치마크 둘이 같은 계열색이면 어느 선이 SPY인지 범례를 다시 봐야 했음). 모르는 책은 남는 색을 돌려 씁니다.
 * dataviz 검증기(라이트 #ffffff·다크 #1a1a19): 예전 회색 #8B949E는 바로 앞 초록과 정상 시각 ΔE 13.5(15 미만)라 한 단계 어둡게
 * #6b727e(초록과 15.1·색약 8.8, 대비 4.9/3.6:1)로, 남는 색의 청록 #39C5CF는 다크 밝기 띠(0.755) 밖이라 #22a2bd로 옮겼습니다.
 * 회색은 범주 색이 아니라 채도 검사는 적용하지 않습니다.
 *
 * 다섯째 미국 계좌 Claude 계좌2(체결 시점 실험 — 계좌2 명세 §13-3)는 자주 #a438a0: 같은 검증기로 라이트(#ffffff)·다크(#1a1a19) 모두 파랑·주황·초록과
 * **모든 쌍**에서 통과합니다(--pairs all — 이 색이 낀 쌍의 색약 ΔE 최소 11.1·정상 시각 22.6, 네 색 전체 최악은 기존 주황↔초록 9.4·20.9, 대비 3:1 이상,
 * 밝기 띠·채도 안). 노출 추이(주황·파랑·자주)·S = 100 보기(주황·자주·초록)에서는 어느 둘이 맞닿아도 갈립니다. 다섯 계좌를 함께 그리는 순자산 곡선에는
 * 회색(60/40)도 있어, 같은 검증기로 자주↔회색은 색약 ΔE 6.5(deutan — 6~8 띠는 보조 부호가 있을 때만 허용)·정상 시각 18.0입니다(라이트·다크 같음,
 * 초록↔회색은 15.1). 순자산 곡선은 계좌 이름 범례(글자)가 보조 부호라 이 쌍을 허용합니다. 남는 색의 보라 #a371f7는 파랑과 색약 ΔE 3.9·정상 13.9라
 * 쓰지 않았습니다.
 */
const BOOK_COLORS: Record<string, string> = {
  rules: SERIES_COLORS.blue,
  claude: SERIES_COLORS.orange,
  claude2: "#a438a0",
  bench_spy: SERIES_COLORS.green,
  bench_mix: "#6b727e",
  // 한국 네 계좌 — 미국과 같은 자리(규칙 파랑·Claude 주황·지수 초록·60/40 회색)라 같은 검증 결과를 그대로 씁니다.
  kr_rules: SERIES_COLORS.blue,
  kr_claude: SERIES_COLORS.orange,
  kr_bench_k200: SERIES_COLORS.green,
  kr_bench_mix: "#6b727e",
};
const SPARE_COLORS = ["#a371f7", "#22a2bd", "#db6d28"];
/**
 * 한국 노출 맞춘 참고선(K40)의 색 — 남는 색의 첫 보라(#a371f7, KRX 화면과 같은 검증된 계열 색)를 점선으로. 계좌 넷(파랑·주황·초록·회색) 뒤에
 * 놓여 계좌 선과 색·선 모양 둘 다 다르고, 범례 이름 '…(계좌 아님)'이 함께 뜻을 나릅니다.
 */
const REFERENCE_COLOR = SPARE_COLORS[0];

/**
 * Claude 노출 추이의 두 선 — 목표는 순자산 곡선의 Claude 책 색(주황), 실제는 검증된 팔레트의 다음 색(파랑). 두 색은 charts의
 * 팔레트 검증을 통과한 이웃 쌍이라 색약에서도 갈립니다. 한 축(%)이고, 범례가 이름을 함께 적어 색만으로 구분하지 않습니다.
 */
const EXPOSURE_COLORS: Record<string, string> = {
  target: SERIES_COLORS.orange,
  actual: SERIES_COLORS.blue,
  // 미국 Claude 계좌2의 실제 노출 — 순자산 곡선의 계좌2 색(위 BOOK_COLORS — 주황·파랑과 모든 쌍 통과).
  [CLAUDE2_EXPOSURE_KEY]: BOOK_COLORS.claude2,
};

/** 계좌 상세 패널의 id — 카드 단추의 aria-controls가 가리킵니다(한 번에 하나만 열림). */
const ACCOUNT_PANEL_ID = "paper-account-detail";
const accountToggleId = (code: string) => `paper-account-toggle-${code}`;

/**
 * 개요 탭(설계서 §7) — 네 계좌 행(AssetRow: 이름·종류·상태·순자산·출발 이후 수익률·배지, 누르면 목록 아래에 그 계좌의 상세 — 정의·핵심
 * 숫자·구성 도넛·최근 체결, AccountDetailPanel), 기간별 순자산 곡선(프레임 판 경계 세로선), 계좌 비교 표(예전 카드의 칸 전부 — 상태·종류·
 * 출발·처음 현금·순자산·수익률·노출·현금·보유·마지막 관측·가격 없음·통계 일곱 칸·비교 기준, 그 아래 표본 설명), Claude 노출 추이(목표 vs
 * 실제), Claude 호출 사용량(오늘·이달·추정 비용 — 상태 응답), 신호 기관(최근
 * 선정), OS 게이트 지표(참고), 장부 관측치 신선도(와 재무 수집 범위 한 줄 — 상태 응답, D28), 작업 기록. 초기화 전이거나 벤치마크가
 * 아직 사후 체결을 기다리면(pendingBackfill) "초기화" 버튼, 규칙 책이 시작 전이면
 * "규칙 계좌 시작" 버튼, Claude 계좌가 시작 전이면 "미리보기"·"Claude 계좌 시작" 버튼(ClaudeStartSection).
 *
 * 숫자는 개요 응답 그대로 그립니다(행·표의 글은 lib/paperOverview가 bookCard에서 만듦). 버튼이 성공하면 onChanged(개요 다시 읽기)를
 * 불러 행·곡선·표를 새 장부로 바꿉니다.
 *
 * 한국(`market` "KR", 2단계 명세 §4-16): 계좌 행·순자산 곡선·비교 표·Claude 노출 추이·사용량은 같은 패턴을 원 단위 정수로 그리고, 미국 전용
 * 카드(초기화·사후 체결 대기·규칙/Claude 계좌 시작·신호 기관·OS 게이트)는 그리지 않습니다 — 한국 네 계좌는 출발일 밤 결정으로 함께 출발하고
 * 13F·게이트 지표가 없습니다. 상태·리스크 점검은 `?market=KR` 경로입니다.
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
  // 상세를 연 계좌 코드(한 번에 하나). 이 화면은 주소 쿼리를 쓰지 않아 화면 상태로만 둡니다 — 개요를 다시 읽어도 그대로입니다.
  const [selected, setSelected] = useState<string | null>(null);
  // 순자산 곡선의 기간 — 처음엔 전체. 저장된 기록보다 긴 기간 탭은 그리지 않습니다(lib navRangeKeys).
  const [navRange, setNavRange] = useState<NavRangeKey>("all");
  // 패널을 열면 초점을 패널 제목으로 옮깁니다 — 화면만 패널로 내려가고 초점이 행 단추에 남으면 다음 Tab이 다른 행 단추를 돌며
  // 화면을 다시 끌어올리고, Esc(패널 안에서만 들음)도 듣지 않았습니다. 닫으면 closeAccount가 그 행 단추로 돌려보냅니다.
  // 패널은 계좌 목록 맨 아래에 열립니다 — 연 패널이 보이도록 가까운 쪽으로만 스크롤하고,
  // 움직임 줄이기(prefers-reduced-motion)를 켠 사람에게는 부드러운 스크롤 대신 바로 옮깁니다(브라우저가 스크립트 스크롤까지 바꿔
  // 주지는 않음).
  useEffect(() => {
    if (!selected) return;
    document.getElementById(accountDetailTitleId(ACCOUNT_PANEL_ID))?.focus({ preventScroll: true });
    const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(ACCOUNT_PANEL_ID)?.scrollIntoView?.({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
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
  // 계좌 숫자의 기준 시각 — 네 계좌는 같은 리스크 점검에서 함께 평가돼 보통 하나(가장 늦은 것을 적음, 모르면 생략).
  const observedAt = latestObserved(books);
  const selectedBook = books.find((book) => book.code === selected) ?? null;
  const toggleAccount = (code: string) => setSelected((current) => (current === code ? null : code));
  const closeAccount = () => {
    const code = selected;
    setSelected(null);
    // 키보드로 연 사람이 닫은 뒤 길을 잃지 않게 그 계좌 행의 단추로 돌아갑니다.
    if (code) document.getElementById(accountToggleId(code))?.focus();
  };
  // 기간을 고르면 그 기간의 기록만 그립니다(값은 그대로 — 날짜와 계좌별 값을 같은 자리에서 자름).
  const navRanges = navRangeKeys(overview.navSeries);
  const range = allowedRangeKey(navRange, NAV_RANGES, navRanges) ?? "all";
  const navWindow = navSeriesWindow(overview.navSeries, range);
  const accounts = navChart(navWindow, books);
  // 한국은 노출 맞춘 참고선(K40 — 계산만, 계좌 아님)을 같은 축의 점선 계열로 더합니다(출발 전·F2 전 서버면 계열 없음).
  const reference = korea ? withKrReference(accounts.rows, overview.exposureReference) : { rows: accounts.rows, series: [] };
  const chart = { rows: reference.rows, series: [...accounts.series, ...reference.series] };
  const referenceNotes = korea ? krReferenceNotes(overview.exposureReference) : null;
  // 하루 움직임이 1달러 미만이면 정수 눈금이 같은 숫자로 반복됩니다 — 축을 조금 펼치고 자릿수를 간격에 맞춥니다(참고선도 축 범위에 넣음).
  const navY = navAxis(chart);
  const series = chart.series.map((line, index) => ({
    ...line,
    color: line.key === KR_REFERENCE_KEY ? REFERENCE_COLOR : BOOK_COLORS[line.key] ?? SPARE_COLORS[index % SPARE_COLORS.length],
    // 원 단위 정수 장부 — 툴팁에 없는 소수 자리를 붙이지 않음(미국은 기본 2자리 그대로).
    ...(korea ? { valueDigits: 0 } : {}),
    ...(line.key === KR_REFERENCE_KEY ? { dashed: true } : {}),
  }));
  const quotes = overview.quotes ?? null;
  const staleNames = quotes?.staleTickers ?? [];
  // 미국 전용 — 출발일 종가 사후 체결 초기화(한국은 출발 상태 카드가 맡음).
  const prompt = korea ? null : initPrompt(overview);
  const initResult = init.result && (
    <Banner tone={init.result.skipped?.length ? "warn" : "info"}>초기화 — {initResultText(init.result)}</Banner>
  );
  const startPrompt = korea ? null : rulesStartPrompt(overview);
  const startView = start.result ? initialDecisionResultView(start.result) : null;
  const startResult = startView && <Banner tone={startView.tone}>{startView.text}</Banner>;
  const selection = selectedFilersView(overview.selection);
  const hasClaude = books.some((book) => book.kind === "CLAUDE");
  // 미국 Claude 계좌2(체결 시점 실험) — 출발했으면 노출 추이에 계좌2 실제 노출 선(그 순자산 기록)을, 'S = 100 같은 구간'은 출발일을 기준으로.
  const book2 = korea ? undefined : books.find((book) => isTimedBook(book.code));
  const book2Nav = useApi<PaperNavResponse>(book2?.startedOn ? endpoints.paper.nav(book2.code) : null, 60_000);
  const exposure = claudeExposureChart(
    overview.claudeExposureSeries,
    book2?.startedOn && book2Nav.data?.available ? (book2Nav.data.series ?? []) : null,
  );
  const exposureSeries = exposure.series.map((line) => ({ ...line, color: EXPOSURE_COLORS[line.key] ?? SPARE_COLORS[0] }));
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
  // 🧪 출발한 계좌2의 1분봉 저장본 한 줄(상태 응답 claude2.bars — 정규장일 때만 받은 시각·지연, 시작 전이면 줄 없음).
  const barsLine = !korea && status.data?.available ? claude2BarsLine(status.data.claude2, book2?.label) : null;
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
  const comparison = accountComparisonRows(books, market);
  const ledgerSource = korea ? PAPER_SOURCES.krLedger : PAPER_SOURCES.ledger;
  const comparisonColumns: Column<ComparisonRow>[] = [
    // 줄이 항목이라 항목 이름 칸을 행 머리(th scope=row)로 — 낭독기가 칸마다 "순자산 · 규칙 계좌"처럼 항목과 계좌를 함께 읽습니다.
    { key: "label", header: "항목", rowHeader: true, cell: (row) => row.label, className: "whitespace-nowrap text-text-2" },
    ...books.map((book): Column<ComparisonRow> => ({
      key: book.code,
      header: book.label,
      align: "right",
      cell: (row) => comparisonContent(row, book.code),
    })),
  ];

  return (
    <>
      {status.data?.available && status.data.enabled === false && (
        <Banner tone="warn">
          정기 작업이 꺼져 있습니다(<code>PAPER_ENABLED=false</code>) —{" "}
          {korea && overview.initialized === false
            // 한국 계좌가 없으면 '리스크 지금 실행' 단추도 없습니다(화면 확인 — 없는 단추를 가리키지 않게).
            ? "한국 리스크 점검·결정·출발도 정기적으로 돌지 않습니다."
            : <>리스크 작업(체결·스탑·평가)은 아래 &quot;리스크 지금 실행&quot;을 누를 때만 돕니다.</>}
        </Banner>
      )}
      {/* 상태를 읽지 못하면 꺼짐·켜짐을 모릅니다 — 배너가 조용히 사라지면 켜져 있는 것으로 읽히므로 그렇다고 적습니다(홈과 같은 문구). */}
      {status.error && <Banner tone="warn">정기 작업 상태를 확인하지 못했습니다 — {status.error}</Banner>}

      {prompt && (
        <Card title={prompt.title} source={PAPER_SOURCES.ledger}>
          <p className="text-sm leading-relaxed text-body">{prompt.body}</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={() => void runInit()} disabled={init.busy}>
              {init.busy ? `초기화 중… ${initElapsed}초` : "초기화"}
            </Button>
          </div>
          {init.error && <div className="mt-3"><Banner tone="warn">{init.error}</Banner></div>}
          {/* 종가가 없어 건너뛴 벤치마크의 서버 사유는 다시 누를 버튼 바로 아래에 둡니다. */}
          {initResult && <div className="mt-3">{initResult}</div>}
        </Card>
      )}
      {/* 카드가 사라진 뒤(모두 시작함)에도 초기화 결과는 남겨 둡니다 — 무엇을 만들고 체결했는지 읽을 수 있게. */}
      {!prompt && initResult}

      {startPrompt && (
        <Card title={startPrompt.title} subtitle="초기 결정 — 출발일 종가 사후 체결" source={PAPER_SOURCES.decisions}>
          <p className="text-sm leading-relaxed text-body">{startPrompt.body}</p>
          {confirmingStart ? (
            <div className="mt-3 flex flex-col gap-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-3">
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
          {start.error && <div className="mt-3"><Banner tone="warn">{start.error}</Banner></div>}
          {startResult && <div className="mt-3">{startResult}</div>}
        </Card>
      )}
      {/* 시작한 뒤(개요를 다시 읽어 카드가 사라짐)에도 결과는 남깁니다 — 주문·사후 체결 수를 읽을 수 있게. */}
      {!startPrompt && startResult}

      {!korea && <ClaudeStartSection overview={overview} onChanged={onChanged} />}
      {!korea && <Claude2StartSection overview={overview} status={status.data ?? null} onChanged={onChanged} />}
      {korea && <KrStartSection overview={overview} status={status.data ?? null} onChanged={onChanged} />}

      {/* 정규장 동안 n분마다 움직이는 장중 평가(표시 전용 추정) — 아래 계좌 목록은 장부의 마지막 관측치 값 그대로입니다. */}
      {overview.initialized !== false && books.length > 0 && <LiveValuationCard market={market} />}

      <Card
        title="계좌"
        subtitle={`순자산·수익률(출발 이후)은 장부의 마지막 관측치 기준${observedAt ? `(${observedAt} KST)` : ""} · 행을 누르면 그 계좌의 상세${
          status.data?.settingsVersion ? ` · 설정 v${status.data.settingsVersion}` : ""
        }${korea && overview.initialized !== false ? ` · ${KR_RISK_RUN_NOTE}` : ""}`}
        source={ledgerSource}
        actions={
          overview.initialized !== false && (
            <Button onClick={() => void runRisk()} disabled={risk.busy}>
              {risk.busy ? `실행 중… ${riskElapsed}초` : "리스크 지금 실행"}
            </Button>
          )
        }
      >
        {risk.error && <div className="mb-3"><Banner tone="warn">{risk.error}</Banner></div>}
        {risk.result && (
          <div className="mb-3"><RiskResult view={korea ? krRiskResultView(risk.result) : riskResultView(risk.result)} /></div>
        )}
        {books.length === 0 ? (
          <p className="text-sm text-muted">
            {korea
              ? "한국 계좌가 없습니다 — 한국 초기화를 하면 네 계좌가 현금만 든 '시작 전'으로 생깁니다(쉬는 사유는 화면 위)."
              : "계좌가 없습니다. 초기화하면 생깁니다."}
          </p>
        ) : (
          <>
            {/* 계좌 행(설계서 §7) — 행 전체가 펼침 단추(aria-expanded·aria-controls)라 어디를 눌러도 상세가 열리고 다시 누르면 닫힙니다. */}
            <ul aria-label="계좌 목록" className="overflow-hidden rounded-xl border border-border bg-surface">
              {books.map((book) => {
                const open = book.code === selected;
                return (
                  <li key={book.code} className="border-t border-border first:border-t-0">
                    <AssetRow
                      row={bookAssetRow(book, { pendingBackfill: overview.pendingBackfill, quotes, market })}
                      onSelect={toggleAccount}
                      selected={open}
                      disclosure={{
                        id: accountToggleId(book.code),
                        controls: ACCOUNT_PANEL_ID,
                        expanded: open,
                        hint: open ? "상세 닫기" : "상세 보기",
                      }}
                    />
                  </li>
                );
              })}
            </ul>
            {selectedBook && (
              <AccountDetailPanel
                key={selectedBook.code}
                id={ACCOUNT_PANEL_ID}
                book={selectedBook}
                books={books}
                onClose={closeAccount}
                onOpenTab={onOpenTab}
                market={market}
              />
            )}
          </>
        )}
      </Card>

      <Card
        title="순자산 곡선"
        subtitle={`${korea ? "KR 거래일" : "거래일"}별 순자산(${marketMeta(market).unitLabel}). 그날 기록이 없는 계좌는 선을 끊어 그립니다 — 시작 전인 계좌는 선이 없습니다.`}
        source={boundaries.text ? `${ledgerSource} · 프레임 경계는 ${PAPER_SOURCES.boundaries}` : ledgerSource}
        actions={
          // 기간이 '전체' 하나뿐이면(출발 직후) 탭을 그리지 않습니다 — 고를 것이 없는 탭은 소음입니다.
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
          // 원 단위 정수 눈금("100,000,000")은 기본 폭(64px)에서 잘립니다 — 한국만 넓힙니다.
          axisWidth={korea ? 84 : undefined}
        />
        {boundaries.text && <p className="mt-2 text-xs text-muted">{boundaries.text}</p>}
        {/* 규칙 계좌 결과는 종목 신호와 주식 노출이 섞인 값 — 미국(남는 현금 SHY)·한국(153130, 참고선과 함께) 같은 함수(2단계 명세 §4-16). */}
        <p className="mt-2 text-xs text-muted">{exposureNote(market)}</p>
        {referenceNotes && (
          <ul aria-label="노출 맞춘 참고선 설명" className="mt-2 flex flex-col gap-0.5 text-xs text-muted">
            {referenceNotes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        )}
      </Card>

      {books.length > 0 && (
        <Card
          title="계좌 비교"
          subtitle={`${korea ? "네 계좌를" : "계좌를"} 항목별로 나란히 — 순자산·수익률·노출은 마지막 관측치 기준 · 통계는 거래일별 순자산 기준(초과 수익률·베타는 '비교 기준' 줄의 계좌 대비)`}
          source={ledgerSource}
        >
          <DataTable<ComparisonRow>
            columns={comparisonColumns}
            rows={comparison}
            rowKey={(row) => row.key}
            caption="계좌 비교"
            scrollHint="overflow"
          />
          <ul aria-label="표본 설명" className="mt-3 flex flex-col gap-0.5 text-xs text-text-3">
            {sampleNotes(books).map((note) => (
              <li key={note.code}>
                <span className="font-medium text-text-2">{note.label}</span> — {note.text}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {!korea && book2 && <SameWindowCard overview={overview} books={books} />}

      {hasClaude && (
        <Card
          title="Claude 노출 추이"
          subtitle={`목표 = Claude가 결정마다 정한 주식 노출(기록·표시용 — 집행은 주문 기준) · 실제 = 그 거래일 장부의 주식 노출${
            exposure.series.some((line) => line.key === CLAUDE2_EXPOSURE_KEY)
              ? "(목표·실제는 계좌1) · 계좌2 실제 = Claude 계좌2 장부의 주식 노출"
              : ""
          }. 기록이 없는 날은 선을 끊어 그립니다.`}
          source={PAPER_SOURCES.exposure}
        >
          {exposure.rows.length === 0 ? (
            <p className="text-sm text-muted">
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
              {exposure.latest && <p className="mt-2 text-xs text-muted">마지막 {exposure.latest}</p>}
            </>
          )}
        </Card>
      )}

      {!korea && hasClaude && <ExecutionExperimentCard books={books} />}

      {hasClaude && usage && (
        <Card
          title="Claude 호출 사용량"
          subtitle={korea
            ? "결정·출발·재시도·프레임 제안·복기의 호출 수·토큰·추정 비용(KST 날짜 기준) — 하루 상한은 미국·한국 책이 함께 쓰고, 수동 호출은 정기 작업 몫을 남긴 문턱까지입니다"
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
          <p className="mt-2 text-xs text-muted">{usage.costNote}</p>
          {usage.note && <p className="mt-1 text-xs text-muted">{usage.note}</p>}
        </Card>
      )}

      {/* 한 칸일 때도 grid-cols-1(minmax(0, 1fr)) — 칸 수를 주지 않으면 auto 칸이 안쪽 표(최소 640px)만큼 늘어나 390px에서 두 카드가 화면 밖으로 잘렸습니다. */}
      {!korea && (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card
          title="신호 기관"
          subtitle={selection
            ? `${selection.asOfDate} 선정 — 규칙 계좌가 두 그룹을 합친 신호 풀의 13F 변화를 신호로 씁니다(다음 재선정일까지)`
            : "규칙 계좌가 13F 신호를 읽는 기관(그룹 A: 후보 트랙레코드 상위 · 그룹 B: 기존 13F 메뉴 최근 상위)"}
          source={PAPER_SOURCES.selection}
        >
          {!selection ? (
            <p className="text-sm text-muted">아직 기관 선정이 없습니다 — 규칙 계좌를 시작하면 출발일 기준으로 선정하고, 그 뒤는 재선정일마다 다시 뽑습니다.</p>
          ) : selection.groupA.length === 0 && selection.pool.length === 0 ? (
            <p className="text-sm text-muted">선정이 비어 있습니다 — 자격 있는 기관이 없었습니다(규칙 계좌는 매수 없이 SHY만 듭니다).</p>
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
                  <h3 className="text-xs font-semibold text-bright">신호 풀 · 기관 가중</h3>
                  <Table<PoolRow>
                    label="신호 풀"
                    rows={selection.pool}
                    rowKey={(row) => row.key}
                    columns={[
                      { key: "name", header: "기관", render: (row) => <span className="font-semibold text-bright">{row.name}</span> },
                      {
                        key: "group",
                        header: "그룹",
                        render: (row) => (row.group ? <GroupBadge badge={row.group} /> : <span className="text-muted">{EMPTY}</span>),
                      },
                      { key: "ranks", header: "순위", render: (row) => <span className="whitespace-nowrap">{row.ranks}</span> },
                      { key: "weight", header: "기관 가중", align: "right", render: (row) => row.weight },
                    ]}
                  />
                </section>
              )}
            </div>
          )}
        </Card>

        <Card title="OS 게이트 지표" subtitle="참고 — 구속하지 않음 · 과거 OS가 쓴 매크로 트리거 수준" source={PAPER_SOURCES.gate}>
          <GateIndicatorBody gate={overview.gate} />
        </Card>
      </div>
      )}

      {korea ? (
        <KrCollectionCard status={status} quotes={quotes} />
      ) : (
        <Card
          title="장부 관측치"
          subtitle="체결·스탑·평가에 쓰는 저장본입니다. 장중이면 마지막 봉이 지연 시세입니다."
          source={observationSource}
          actions={
            quotes && (
              <Freshness collectedAt={quotes.collectedAtKst} ageSeconds={quotes.ageSeconds ?? undefined} stale={quotes.stale} />
            )
          }
        >
          <p className="text-sm text-body">{quotesLine(quotes)}</p>
          {staleNames.length > 0 && (
            <p className="mt-1 text-xs text-warn">지난 값을 이어 쓴 티커: {staleNames.join(", ")}</p>
          )}
          {barsLine && <p className="mt-1 text-xs text-muted">{barsLine}</p>}
          {fundamentals && <p className="mt-1 text-xs text-muted">{fundamentals}</p>}
          {calendar && <p className="mt-1 text-xs text-muted">{calendar}</p>}
          {news && <p className="mt-1 text-xs text-muted">{news}</p>}
          {earnings && <p className="mt-1 text-xs text-muted">{earnings}</p>}
        </Card>
      )}

      <Card title="작업 기록" subtitle={jobsCardSubtitle(market)} source={PAPER_SOURCES.jobs}>
        <Table<PaperJobRun>
          label="작업 기록"
          // 미국 개요 응답의 작업 기록은 한국 kr.* 줄도 담아(미국 응답 글자 그대로 — x3) 화면에서 그 시장 줄만 남깁니다.
          rows={marketJobs(overview.jobs, market)}
          rowKey={(row, index) => `${row.job}-${row.startedAtKst ?? index}-${index}`}
          emptyMessage={jobsEmptyMessage(market, overview.jobs)}
          columns={[
            { key: "job", header: "작업", render: (row) => row.job },
            { key: "startedAt", header: "시작", render: (row) => formatKst(row.startedAtKst) },
            { key: "finishedAt", header: "끝", render: (row) => formatKst(row.finishedAtKst) },
            {
              key: "outcome",
              header: "결과",
              render: (row) => <span className={jobOutcomeClass(row.outcome)}>{row.outcome || EMPTY}</span>,
            },
            {
              key: "detail",
              header: "상세",
              render: (row) => (
                <span className="text-xs text-muted" title={jsonTitle(row.detail)}>
                  {korea ? krJobDetailText(row) : jsonSummary(row.detail)}
                </span>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}

/**
 * 🧪 "S = 100 같은 구간"(계좌2 명세 §4-2의 2·§13-3) — 계좌2 출발일 S를 기준일로 계좌1·계좌2·SPY 계좌의 순자산을 100에 맞춘 선(서술용 — 판정은
 * '체결 시점 실험'의 주문 단위 반사실). 계좌2가 출발하기 전이면 그렇다고 적고 그리지 않습니다(S 이전 구간은 계좌2 값이 없어 100으로 채우지 않음).
 */
function SameWindowCard({ overview, books }: { overview: PaperOverviewResponse; books: readonly PaperBookSummary[] }) {
  const view = sameWindowIndex(overview.navSeries, books);
  const series = (view?.series ?? []).map((line, index) => ({
    ...line,
    color: BOOK_COLORS[line.key] ?? SPARE_COLORS[index % SPARE_COLORS.length],
  }));
  return (
    <Card
      title="S = 100 같은 구간"
      subtitle={view
        ? `기준일 S = ${view.baseDate}(Claude 계좌2 출발일)의 순자산을 100으로 — 계좌1·계좌2·SPY 계좌가 같은 구간을 겪은 결과(서술용, 판정에 쓰지 않음). S 이전 계좌2 값은 없습니다(—).`
        : "Claude 계좌2가 출발하면 그 출발일 S의 순자산을 100으로 맞춰 계좌1·계좌2·SPY 계좌를 같은 구간에서 나란히 그립니다(서술용, 판정에 쓰지 않음)."}
      source={PAPER_SOURCES.sameWindow}
    >
      {!view ? (
        <p className="text-sm text-muted">아직 계좌2가 출발하지 않았습니다 — 출발 전 구간은 계좌2 값이 없어(—) 그리지 않습니다.</p>
      ) : (
        <>
          <MultiLineSeries data={view.rows} series={series} precision={1} height={240} ariaLabel="S = 100 같은 구간" />
          {view.latest && <p className="mt-2 text-xs text-muted">마지막 {view.latest}</p>}
          {view.missingBase.length > 0 && (
            <p className="mt-1 text-xs text-warn">기준일에 순자산 기록이 없어 선을 그리지 않은 계좌: {view.missingBase.join(", ")}</p>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * 리스크 작업 결과. ok:false(한 책이 오류로 되돌려짐)면 경고 배너에 오류를, 성공이든 아니든 처리 메모를 목록으로 보입니다 —
 * HTTP 200이라 버튼은 성공으로 끝나므로, 응답의 ok를 보지 않으면 실패가 정상 완료 문구로 보였습니다.
 */
function RiskResult({ view }: { view: RiskResultView }) {
  return (
    <Banner tone={view.tone}>
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
    </Banner>
  );
}

/** 사용량 칸 묶음 하나(오늘·이달). */
function UsageCells({ label, cells }: { label: string; cells: readonly { key: string; label: string; value: string }[] }) {
  return (
    <section aria-label={`Claude 호출 사용량 ${label}`} className="flex flex-col gap-1">
      <h3 className="text-xs font-semibold text-bright">{label}</h3>
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
      <h3 className="text-xs font-semibold text-bright">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted">{empty}</p>
      ) : (
        <ol className="space-y-0.5 text-xs text-body">
          {rows.map((row) => (
            <li key={row.key} title={`CIK ${row.cik}`}>
              <span className="tabular-nums text-muted">{row.rank}</span> <span>{row.name}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function GroupBadge({ badge }: { badge: Badge }) {
  return (
    <span title={badge.title} className={`whitespace-nowrap rounded-sm border px-1.5 py-px text-[10px] ${badge.className}`}>
      {badge.label}
    </span>
  );
}

/** 계좌 비교 표의 칸 — 상태는 배지, 색이 있는 값(수익률·가격 없음)은 그 색, 나머지는 글 그대로("—"면 표가 Empty로 그림). */
function comparisonContent(row: ComparisonRow, code: string): ReactNode {
  const cell = row.cells[code];
  if (!cell || cell.text === EMPTY) return cell?.text ?? null;
  if (row.badge && cell.className) {
    return <span className={`whitespace-nowrap rounded-sm border px-2 py-0.5 text-[11px] ${cell.className}`}>{cell.text}</span>;
  }
  return cell.className ? <span className={cell.className}>{cell.text}</span> : cell.text;
}

function Cell({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className={`tabular-nums text-bright ${small ? "text-xs" : "text-sm font-semibold"}`}>{value}</dd>
    </div>
  );
}
