"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ScrollTopButton } from "@/components/ScrollTopButton";
import { BrokerageSection } from "@/components/screens/brokerage/BrokerageSection";
import { IsaSection } from "@/components/screens/isa/IsaSection";
import { RealTradePanel } from "@/components/screens/realtrade/RealTradePanel";
import { RealTradeProvider } from "@/components/screens/realtrade/RealTradeProvider";
import { RealTradeToggle } from "@/components/screens/realtrade/RealTradeToggle";
import { Button, Callout, ErrorState, Loading, SKELETON_BAR, Tabs, underlineTabClasses } from "@/components/ui";
import { firstLoadPending, useApi } from "@/hooks/useApi";
import { TickerNamesProvider } from "@/hooks/useTickerNames";
import { endpoints } from "@/lib/endpoints";
import { isTimedBook, PAPER_SOURCES, paperTabInMarket, paperTabsFor, type PaperTabKey } from "@/lib/paper";
import { KR_TAB_LABELS } from "@/lib/paperKrProfiles";
import { formatMoney, type PaperMarketCode } from "@/lib/paperMarket";
import { paperTabFromPath, paperTabPath } from "@/lib/paperRoutes";
import type { PaperNamesResponse, PaperOverviewResponse } from "@/lib/types";
import { DecisionsSection } from "./DecisionsSection";
import { FrameworkSection } from "./FrameworkSection";
import { HoldingsSection } from "./HoldingsSection";
import { KrSelectionSection } from "./KrSelectionSection";
import { NotesSection } from "./NotesSection";
import { OverviewSection } from "./OverviewSection";
import { PaperHeader } from "./PaperHeader";
import { PaperHeaderSlotsProvider } from "./PaperTabHeader";
import { SelectionSection } from "./SelectionSection";
import { SettingsSection } from "./SettingsSection";

/**
 * 모의 알고리즘 매매(운영자 전용).
 *
 * <p>같은 돈·같은 날 출발한 네 계좌(규칙 · Claude · SPY(100%) · 60/40(SPY 60%·SHY 40%))의 장부를 봅니다. 미국은 다섯째 계좌 Claude 계좌2(체결
 * 시점 실험 — 늦게 앞으로 체결로 출발, ADR 0022)가 더해지고, 한계 문구 아래에 계좌2의 한계(CLAUDE2_LIMITS)를 덧붙입니다.
 * 주문은 어디로도 나가지 않습니다. 숫자는 전부 백엔드 장부가 계산한 값이고, 이 화면은 조회·배치만 합니다(ADR 0004).
 *
 * <p>개요 응답 하나를 이 파일이 읽어 섹션에 나눠 줍니다 — 보유·체결 탭과 결정 로그 탭의 책 목록도 개요의 책 목록입니다
 * (탭마다 따로 읽으면 탭들이 서로 다른 시점의 책 상태를 보일 수 있음). 기관 선정 탭은 책 상태와 관계없는 트랙레코드 응답을
 * 그 탭이 열릴 때 스스로 읽습니다(프레임·메모·설정 탭도 같음 — 책 상태와 따로 읽고 씁니다). 메모 탭에는 출발일만 넘깁니다(시작 패킷에
 * 실리는 메모의 기준일 안내). 한계 문구는 어느 탭에서든 머리의 서랍 단추 '이 장부의 한계 (n줄)'로 엽니다(작업대 P6 — PaperHeader·PaperLimitsDrawer).
 *
 * <p>개요의 계좌 상세에서 "보유·체결 탭에서 전체 보기"·"결정 로그 보기"를 누르면 그 탭으로 바꾸며 그 계좌를 미리 고릅니다(preselect —
 * 탭이 처음 그려질 때의 선택). 탭 단추로 직접 옮기면 미리 고름을 지워, 그 탭의 기본 계좌로 엽니다(예전과 같음). 결정 로그의 주간 복기에서
 * 제안을 누르면 프레임 탭으로 바꾸며 그 제안 번호를 넘깁니다(focusProposal — 같은 규칙으로 탭 단추가 지움).
 *
 * <p>주소: 개요는 /paper/us, 나머지 탭은 /paper/us/&lt;탭&gt;(lib/paperRoutes). 라우트가 처음 탭(initialTab)을 넘기고, 화면 안에서 탭을
 * 바꾸면 window.history.replaceState로 주소만 그 탭의 것으로 바꿉니다 — 라우터 이동(useRouter)을 쓰지 않아 섹션이 다시 읽히지 않고,
 * 새로고침·링크 공유는 그 탭으로 열립니다(뒤로 가기 기록은 쌓지 않음). 반대로 같은 화면을 띄운 채 셸의 링크(예: 모의매매 탭 → /paper/us)로
 * 주소가 바뀌면 그 주소의 탭으로 맞춥니다.
 *
 * <p><b>한국</b>(`market` "KR", 2단계 명세 §4-16 — /paper/kr·/paper/kr/&lt;탭&gt;): 같은 여덟 탭이고 개요는 `?market=KR` 응답(원 단위 정수,
 * 다섯 계좌 kr_rules·kr_claude·kr_claude2·kr_bench_k200·kr_bench_mix)입니다. 정기 작업이 쉬면 그 사유(dormantReason)를 맨 위에 적습니다. 종목 선정 탭(키
 * selection — 미국 '기관 선정' 자리)은 한국 규칙 계좌의 재선정 기록(KrSelectionSection), 메모 탭은 한국 메모(`?market=KR`)입니다. 프레임·설정은
 * 두 시장이 함께 쓰는 화면이라 같은 섹션에 시장을 넘겨 공용임을 밝힙니다(설정은 '한국 + 공용' 보기가 기본). 주소 맞추기는 그 시장의 주소만 봅니다(다른 시장 주소는 무시).
 *
 * <p><b>실제 계좌</b> 탭(키 real, ADR 0025)은 모의 장부가 아니라 토스증권 실제 계좌의 읽기 전용 화면입니다 — 한국 화면은 원화 쪽, 미국 화면은
 * 달러 쪽. 개요 응답을 쓰지 않고 BrokerageSection이 그 탭이 열릴 때만 스스로 읽습니다(자동 갱신·셸 새로고침 없음). 이 파일은 그 섹션을 붙이기만
 * 하고 실제 계좌 자료를 다른 탭에 넘기지 않습니다(경계 시험 components/screens/brokerage/__tests__/brokerageBoundary.test.ts).
 * 그 탭 맨 위에는 실제 매매 칸(RealTradePanel — 실제 계좌가 모의 한국 책을 따라 하기, ADR 0028)을 두고, 같은 켜기·끄기 단추(RealTradeToggle)를
 * 조회 요약의 '다시 읽기' 옆에도 넘깁니다. 이 탭은 개요가 없거나 실패해도 그리고, 그때(탭 줄이 없음) 다른 탭에 있으면 한국 화면은 이 탭으로 가는 단추를
 * 둬 끄기 단추가 늘 닿게 합니다. 실제 매매 모듈을 가져오는 곳은 이 파일
 * 하나입니다(경계 시험 components/screens/realtrade/__tests__/realtradeBoundary.test.ts).
 *
 * <p><b>ISA 계좌</b> 탭(키 isa, ADR 0029)은 한국 화면에만 있는 시장 제한 칸입니다(lib/paper `paperTabsFor`) — 연결되지 않은 다른 증권사 계좌의 장부와
 * 다음 시가 매매 지시. 실제 계좌 탭처럼 개요 응답과 무관하게 IsaSection이 그 탭이 열릴 때만 스스로 읽습니다. 미국 화면에서 그 주소(/paper/us/isa)로
 * 오면 개요를 열고 주소도 개요로 바꿉니다. ISA 모듈을 가져오는 곳은 이 파일 하나입니다(경계 시험 components/screens/isa/__tests__/isaBoundary.test.ts).
 */
export default function PaperPage({
  initialTab = "overview",
  market = "US",
}: {
  initialTab?: PaperTabKey;
  market?: PaperMarketCode;
}) {
  // 한국 화면은 종목 코드 대신 기업명(사용자 결정 2026-11-02) — 이름 표를 한 번 읽어 탭들에 내려 줍니다(10분마다 다시, 실패하면 코드 그대로).
  const names = useApi<PaperNamesResponse>(market === "KR" ? endpoints.paper.market("KR").names : null, 600_000);
  return (
    <TickerNamesProvider names={names.data?.names}>
      <PaperScreenBody initialTab={initialTab} market={market} />
    </TickerNamesProvider>
  );
}

function PaperScreenBody({ initialTab, market }: { initialTab: PaperTabKey; market: PaperMarketCode }) {
  const korea = market === "KR";
  // 이 시장에 없는 탭(미국의 'ISA 계좌')으로 오면 개요로 엽니다.
  const [tab, setTab] = useState<PaperTabKey>(() => (paperTabInMarket(initialTab, market) ? initialTab : "overview"));
  const [preselect, setPreselect] = useState("");
  // 결정 로그의 주간 복기에서 누른 제안 번호 — 프레임 탭이 그 제안으로 스크롤해 강조합니다(탭 단추로 옮기면 지움).
  const [focusProposal, setFocusProposal] = useState<number | null>(null);
  // 머리 칸 둘(작업대 P6 — PaperTabHeader 계약): 탭의 섹션이 계좌 고르기·동작을 이 칸으로 보냅니다(포털). 칸 요소는 콜백 ref로 받아 공급자에 넘깁니다.
  const [accountSlot, setAccountSlot] = useState<HTMLElement | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const { data, loading, error, reload, refreshError, failedAt } = useApi<PaperOverviewResponse>(endpoints.paper.market(market).overview, 60_000);
  // 한국 화면은 이름이 다른 탭(종목 선정)만 한국 이름으로 — 여덟 탭 모두 열림(미국 화면은 PAPER_TABS 그대로). 시장 제한 칸('ISA 계좌')은 한국에만.
  const tabs = paperTabsFor(market).map((entry) => ({ ...entry, label: (korea ? KR_TAB_LABELS[entry.key] : undefined) ?? entry.label }));
  const current = tabs.find((entry) => entry.key === tab) ?? tabs[0];
  // 라우터 밖(테스트)에서는 null입니다 — 그때는 주소를 따라가지 않습니다.
  const pathname = usePathname();
  // 미국 Claude 계좌2(체결 시점 실험) — 머리 줄과 한계 문구에 그 계좌만의 줄을 더합니다(한국 화면은 없음).
  const book2 = korea ? undefined : data?.books?.find((entry) => isTimedBook(entry.code));

  // 이 시장에 없는 탭의 주소(미국 /paper/us/isa)로 열렸으면 주소도 개요로 바꿉니다(기록을 쌓지 않음 — 처음 한 번).
  useEffect(() => {
    if (!paperTabInMarket(initialTab, market) && window.location.pathname === paperTabPath(initialTab, market)) {
      window.history.replaceState(null, "", paperTabPath("overview", market));
    }
  }, [initialTab, market]);

  useEffect(() => {
    const routed = paperTabFromPath(pathname, market);
    // 이 시장에 없는 탭의 주소는 개요로 봅니다.
    const fromPath = routed !== null && !paperTabInMarket(routed, market) ? "overview" : routed;
    // 이 화면이 방금 바꾼 주소(replaceState)는 지금 탭과 같아 아무 일도 없습니다. 라우터가 아직 옛 주소를 들고 있는 동안(탭을 막
    // 바꾼 직후)은 브라우저의 지금 주소와 달라 무시합니다 — 그러지 않으면 방금 고른 탭을 옛 주소의 탭으로 되돌립니다.
    if (fromPath === null || fromPath === tab || pathname !== window.location.pathname) return;
    // 주소로 탭을 바꾸는 것은 탭 단추를 누른 것과 같습니다 — 미리 고른 계좌·강조할 제안을 지웁니다.
    setPreselect("");
    setFocusProposal(null);
    setTab(fromPath);
  }, [pathname, tab, market]);

  // 다른 탭으로 옮긴 단추가 검사 대화상자 안(좁은 화면의 계좌 상세 '보유·체결 탭에서 전체 보기' 등 — 작업대 P6)이면, 바로 옮긴 포커스를 대화상자의 포커스
  // 가두기가 되돌리고 대화상자가 섹션과 함께 사라지며 포커스가 body로 떨어졌습니다. 그래서 그린 뒤(대화상자가 빠진 뒤)에도 한 번, 대화상자의 닫힘 포커스
  // 처리(다음 틱) 뒤에 한 번 더 그 탭으로 옮깁니다. 대화상자 밖이면 처음 한 번으로 끝납니다(같은 단추에 다시 포커스).
  const [tabFocus, setTabFocus] = useState<{ key: PaperTabKey } | null>(null);
  useEffect(() => {
    if (!tabFocus) return;
    const focus = () => document.getElementById(`paper-tab-${tabFocus.key}`)?.focus();
    focus();
    const timer = window.setTimeout(focus, 0);
    return () => window.clearTimeout(timer);
  }, [tabFocus]);
  const focusTab = (key: PaperTabKey) => {
    document.getElementById(`paper-tab-${key}`)?.focus();
    setTabFocus({ key });
  };

  /** 탭을 바꾸고 주소를 그 탭의 것으로 — 기록을 쌓지 않는 replaceState(Next 라우터가 usePathname을 맞춰 줌). */
  const showTab = (key: PaperTabKey) => {
    setTab(key);
    const path = paperTabPath(key, market);
    if (window.location.pathname !== path) window.history.replaceState(null, "", path);
  };
  const openTab = (key: "holdings" | "decisions", code: string) => {
    setPreselect(code);
    setFocusProposal(null);
    showTab(key);
    // 누른 단추는 개요와 함께 사라지므로, 초점을 새 탭 단추로 옮겨 키보드 위치와 화면 위치를 맞춥니다.
    focusTab(key);
  };
  const openProposal = (id: number) => {
    setFocusProposal(id);
    showTab("framework");
    focusTab("framework");
  };

  return (
    <PaperHeaderSlotsProvider account={accountSlot} actions={actionsSlot}>
      <div className="flex flex-col gap-6 lg:gap-8">
        <PaperHeader
          title={`모의 알고리즘 매매(${korea ? "한국" : "미국"})`}
          market={market}
          tab={current.key}
          description={
            korea ? (
              <>
                {/* 한국 장부는 다섯 계좌 — 계좌2도 계좌1의 출발일로 같은 돈에서 출발(백엔드 PaperBooks·startKrClaude2, QA-944). */}
                같은 돈·같은 날 출발한 다섯 계좌 — 규칙 · Claude 계좌1 · Claude 계좌2 · KODEX 200(069500) · 한국 60/40(069500 60%·153130 40%)
                {krInitialCash(data) ? ` · 계좌마다 ${krInitialCash(data)}` : ""}
                {data?.startDate ? ` · 출발 ${data.startDate}` : ""} · 출발일 밤 결정으로 다음 KR 거래일 시가에 함께 출발
              </>
            ) : (
              <>
                같은 돈·같은 날 출발한 네 계좌 — 규칙 · Claude 계좌1 · SPY(100%) · 60/40(SPY 60%·SHY 40%)
                {data?.startDate ? ` · 출발 ${data.startDate}` : ""}
                {book2 ? " · Claude 계좌2(체결 시점 실험)는 같은 돈으로 늦게, 앞으로 체결로 출발" : ""}
              </>
            )
          }
          // 한계 서랍은 개요가 있고 한계 문구가 있을 때만(예전 카드와 같은 조건 — 실제 계좌·ISA 탭만 그리는 때는 없음).
          limits={
            data?.available && (data.limits ?? []).length > 0
              ? { lines: data.limits ?? [], source: korea ? PAPER_SOURCES.krLedger : PAPER_SOURCES.ledger, book2Label: book2?.label ?? null }
              : null
          }
          refreshError={refreshError}
          // 개요를 처음 읽는 동안 머리의 계좌 칸·한계 단추 자리(QA-956) — 계좌 칸은 그 칸을 채우는 탭(개요·보유·체결·결정 로그)만.
          reserve={firstLoadPending({ data, loading, failedAt }) ? { account: accountReserveText(current.key, korea), limits: true } : null}
          realMarker={current.key === "real" || current.key === "isa"}
          onAccountSlot={setAccountSlot}
          onActionsSlot={setActionsSlot}
        />

        {/* 시장 고르기(미국 | 한국 두 링크)는 넓은 화면은 머리의 세그먼트(PaperHeader), 좁은 화면은 셸의 하위 메뉴 줄(lib/nav)이 맡습니다. */}
        {/* 실제 계좌 탭은 개요를 처음 읽는 동안 탭 줄 꼴의 자리(RealTabRowPending — 개요가 오면 그 자리에 탭 줄), 그 밖의 탭과 실패 뒤 다시 읽는 동안은
            읽는 중 글(오류 상자와 번갈아 높이가 오르내리지 않게 — QA-970, QA-655 규약). */}
        {loading && !data && (current.key === "real" && firstLoadPending({ data, loading, failedAt })
          ? <RealTabRowPending />
          : <Loading label="장부를 읽는 중…" />)}
        {error && <ErrorState message={error} onRetry={reload} />}
        {/* 테이블이 아직 없으면 서버 문구 그대로 — 무엇을 하면 생기는지까지 서버가 적어 보냅니다. */}
        {data && !data.available && <Callout tone="warn">{data.message ?? "모의 매매 장부를 읽을 수 없습니다."}</Callout>}
        {/* 한국 정기 작업(리스크 점검·결정·복기)이 쉬는 사유 — 서버 문구 그대로(출발일 없음·한국 초기화 전). 쉬어도 조회는 저장본으로 답합니다. */}
        {korea && data?.available && data.dormantReason && (
          <Callout tone="warn">
            <strong>한국 계좌가 쉬고 있습니다</strong> — {data.dormantReason}
          </Callout>
        )}
        {/* 개요가 아직 없거나 실패·읽을 수 없음이면 탭 줄이 없습니다 — 그래도 실제 매매 끄기 단추(실제 계좌 탭)로 가는 길을 둡니다(SEC-6, ADR 0028).
            개요가 오면 탭 줄이 그 길이라 이 단추는 빠집니다. 실제 매매는 한국만이라 한국 화면에만 둡니다. */}
        {korea && !data?.available && current.key !== "real" && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-text-2">
            <span>실제 매매는 모의 장부와 상관없이 실제 계좌 탭에서 끌 수 있습니다.</span>
            <Button size="sm" onClick={() => showTab("real")}>
              실제 계좌 탭으로(실제 매매 끄기)
            </Button>
          </div>
        )}

        {/* 실제 계좌 탭은 개요 응답과 무관합니다(ADR 0028) — 개요가 아직 없거나 실패해도 그 탭의 실제 매매 칸(끄기 단추)·계좌 조회를 그립니다(탭 줄·머리의 한계
            서랍 단추는 예전처럼 개요가 있을 때만). 같은 자리에 그려 개요가 도착해도 그 칸이 다시 붙지 않습니다(실제 매매 상태·실제 계좌를 두 번 읽지 않게).
            ISA 계좌 탭(ADR 0029)도 개요와 무관한 자기 장부라 같은 규칙으로 그립니다. */}
        {(data?.available || current.key === "real" || current.key === "isa") && (
          <>
            {/* 밑줄 탭(공용 탭 줄 — 위 하위 메뉴 줄보다 한 단계 작게 sm). 좁으면 줄을 바꾸지 않고 가로로 스크롤하며 고른 탭·키보드로 옮긴 탭을 줄 안에
                보이게 합니다. Tab으로는 고른 탭 하나에 들어오고 →·←·Home·End는 포커스만 옮깁니다(여는 것은 누르기·Enter·Space — QA-739). */}
            {data?.available && (
              <Tabs
                label="모의 매매 화면"
                idPrefix="paper-tab"
                panelId="paper-tabpanel"
                size="sm"
                value={current.key}
                items={tabs.map((entry) => ({
                  key: entry.key,
                  label: entry.label,
                  suffix: entry.opensIn ? <span className="ml-1 text-xs text-text-3">(준비 중)</span> : undefined,
                }))}
                onChange={(key) => {
                  setPreselect("");
                  setFocusProposal(null);
                  showTab(key);
                }}
              />
            )}

            {/* 탭 줄이 없을 때(개요 없이 실제 계좌 탭만)는 탭 이름을 패널 이름으로 둡니다. */}
            <div
              role="tabpanel"
              id="paper-tabpanel"
              aria-labelledby={data?.available ? `paper-tab-${current.key}` : undefined}
              aria-label={data?.available ? undefined : current.label}
              className="flex flex-col gap-6"
            >
              {data?.available && current.key === "overview" && (
                <OverviewSection overview={data} onChanged={reload} onOpenTab={openTab} market={market} />
              )}
              {current.opensIn === null && current.key === "selection" && (korea ? <KrSelectionSection /> : <SelectionSection />)}
              {data?.available && current.opensIn === null && current.key === "holdings" && (
                <HoldingsSection books={data.books ?? []} onChanged={reload} initialBook={preselect} market={market} onOpenTab={openTab} />
              )}
              {data?.available && current.opensIn === null && current.key === "decisions" && (
                <DecisionsSection
                  books={data.books ?? []}
                  onChanged={reload}
                  initialBook={preselect}
                  onOpenProposal={openProposal}
                  market={market}
                />
              )}
              {/* 프레임·설정은 두 시장이 함께 쓰는 화면 — 한국 화면에서는 섹션이 맨 위에 공용임을 밝힙니다(사용자 결정 2026-10-29). */}
              {current.key === "framework" && <FrameworkSection focusProposalId={focusProposal} market={market} />}
              {data?.available && current.opensIn === null && current.key === "notes" && <NotesSection startDate={data.startDate ?? null} market={market} />}
              {current.key === "settings" && <SettingsSection market={market} />}
              {/* 실제 계좌(ADR 0025·0028) — 모의 장부와 별개. 이 탭일 때만 붙어 그때만 읽습니다(개요 응답·장부 값을 넘기지 않음). 맨 위는 실제 매매 칸,
                  그 아래 읽기 전용 조회이고, 같은 켜기·끄기 단추를 조회 요약의 '다시 읽기' 옆에도 넘깁니다(조회 모듈은 실제 매매 모듈을 모름). */}
              {current.key === "real" && (
                <RealTradeProvider market={market}>
                  <RealTradePanel />
                  <BrokerageSection market={market} extraActions={<RealTradeToggle />} />
                </RealTradeProvider>
              )}
              {/* ISA 계좌(ADR 0029, 한국만) — 모의 장부와 별개. 이 탭일 때만 붙어 그때만 읽습니다(개요 응답·장부 값을 넘기지 않음). */}
              {current.key === "isa" && <IsaSection />}
              {current.opensIn && (
                <Callout tone="neutral">
                  <strong>{current.label}</strong> 탭은 다음 단계에서 엽니다 — {current.opensIn}.
                  <p className="mt-1 text-xs">이 탭에 올 것: {current.upcoming}</p>
                </Callout>
              )}
            </div>
          </>
        )}
        {/* 맨 위로(TOP) — 사용자 요청 2026-11-03. 조금 내려가면 오른쪽 아래에 나타납니다. */}
        <ScrollTopButton />
      </div>
    </PaperHeaderSlotsProvider>
  );
}

/**
 * 머리 계좌 칸 자리의 글(QA-956) — 개요가 오기 전에는 선택지를 모르므로, 그 칸을 채우는 탭의 흔한 가장 긴 선택지 꼴로 폭을 잡습니다(보이지 않음 — 화면에
 * 내지 않는 글): 개요 탭은 계좌 이름(백엔드 PaperBooks 이름 — 'Claude 계좌1'·'한국 Claude 계좌1'), 보유·체결·결정 로그는 이름 + 상태('· 운용 중' — lib/paper
 * bookOptions). 계좌 칸이 없는 탭은 null.
 */
function accountReserveText(tab: PaperTabKey, korea: boolean): string | null {
  const name = korea ? "한국 Claude 계좌1" : "Claude 계좌1";
  if (tab === "overview") return name;
  if (tab === "holdings" || tab === "decisions") return `${name} · 운용 중`;
  return null;
}

/**
 * 실제 계좌 탭에서 개요를 읽는 동안의 자리 — 개요가 오면 같은 자리에 생기는 탭 줄과 같은 높이(공용 밑줄 탭 sm과 같은 클래스 — 좁은 화면 45px·넓은 화면 31px)의
 * 글 없는 막대 줄입니다(QA-964). 예전에는 읽는 중 글(68px)이 탭 줄로 바뀌며 아래 실제 매매 칸이 위로 37px 올라갔습니다. 탭이 아니라(역할·누르기 없음 — 탭 줄은
 * 개요가 온 뒤에만, SEC-6) 읽는 중 상태만 읽힙니다. 개요가 실패·읽을 수 없음이면 탭 줄 없이 이 자리가 빠집니다(예전 읽는 중 글과 같음).
 */
function RealTabRowPending() {
  return (
    <div role="status" aria-busy="true" aria-label="장부를 읽는 중" className="flex overflow-hidden border-b border-border">
      <span className="sr-only">장부를 읽는 중</span>
      {["w-8", "w-14", "w-14", "w-14", "w-10", "w-8", "w-14", "w-14"].map((width, index) => (
        <span key={index} aria-hidden="true" className={underlineTabClasses(false, "sm")}>
          <span className="flex h-lh items-center">
            <span className={`block h-3 ${width} ${SKELETON_BAR}`} />
          </span>
        </span>
      ))}
    </div>
  );
}

/** 한국 계좌마다의 처음 현금(원 정수) — 개요 책 목록의 값(배포 설정). 모르면 null(문장에서 뺌 — 1억 원을 지어내지 않음). */
function krInitialCash(data: PaperOverviewResponse | null | undefined): string | null {
  const cash = data?.books?.find((book) => typeof book.initialCash === "number")?.initialCash;
  return typeof cash === "number" ? formatMoney(cash, "KR") : null;
}
