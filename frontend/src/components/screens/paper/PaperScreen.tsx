"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Banner, Card, ErrorState, Freshness, Loading } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { PAPER_SOURCES, PAPER_TABS, type PaperTabKey } from "@/lib/paper";
import { paperTabFromPath, paperTabPath } from "@/lib/paperRoutes";
import type { PaperOverviewResponse } from "@/lib/types";
import { DecisionsSection } from "./DecisionsSection";
import { FrameworkSection } from "./FrameworkSection";
import { HoldingsSection } from "./HoldingsSection";
import { NotesSection } from "./NotesSection";
import { OverviewSection } from "./OverviewSection";
import { SelectionSection } from "./SelectionSection";
import { SettingsSection } from "./SettingsSection";

/**
 * 🧪 모의 알고리즘 매매(운영자 전용).
 *
 * <p>같은 돈·같은 날 출발한 네 계좌(규칙 · Claude · SPY(100%) · 60/40(SPY 60%·SHY 40%))의 장부를 봅니다.
 * 주문은 어디로도 나가지 않습니다. 숫자는 전부 백엔드 장부가 계산한 값이고, 이 화면은 조회·배치만 합니다(ADR 0004).
 *
 * <p>개요 응답 하나를 이 파일이 읽어 섹션에 나눠 줍니다 — 보유·체결 탭과 결정 로그 탭의 책 목록도 개요의 책 목록입니다
 * (탭마다 따로 읽으면 탭들이 서로 다른 시점의 책 상태를 보일 수 있음). 기관 선정 탭은 책 상태와 관계없는 트랙레코드 응답을
 * 그 탭이 열릴 때 스스로 읽습니다(프레임·메모·설정 탭도 같음 — 책 상태와 따로 읽고 씁니다). 메모 탭에는 출발일만 넘깁니다(시작 패킷에
 * 실리는 메모의 기준일 안내). 한계 문구는 어느 탭에서든 맨 위에 둡니다.
 *
 * <p>개요의 계좌 상세에서 "보유·체결 탭에서 전체 보기"·"결정 로그 보기"를 누르면 그 탭으로 바꾸며 그 계좌를 미리 고릅니다(preselect —
 * 탭이 처음 그려질 때의 선택). 탭 단추로 직접 옮기면 미리 고름을 지워, 그 탭의 기본 계좌로 엽니다(예전과 같음). 결정 로그의 주간 복기에서
 * 제안을 누르면 프레임 탭으로 바꾸며 그 제안 번호를 넘깁니다(focusProposal — 같은 규칙으로 탭 단추가 지움).
 *
 * <p>주소: 개요는 /paper/us, 나머지 탭은 /paper/us/&lt;탭&gt;(lib/paperRoutes). 라우트가 처음 탭(initialTab)을 넘기고, 화면 안에서 탭을
 * 바꾸면 window.history.replaceState로 주소만 그 탭의 것으로 바꿉니다 — 라우터 이동(useRouter)을 쓰지 않아 섹션이 다시 읽히지 않고,
 * 새로고침·링크 공유는 그 탭으로 열립니다(뒤로 가기 기록은 쌓지 않음). 반대로 같은 화면을 띄운 채 셸의 링크(예: 모의매매 탭 → /paper/us)로
 * 주소가 바뀌면 그 주소의 탭으로 맞춥니다.
 */
export default function PaperPage({ initialTab = "overview" }: { initialTab?: PaperTabKey }) {
  const [tab, setTab] = useState<PaperTabKey>(initialTab);
  const [preselect, setPreselect] = useState("");
  // 결정 로그의 주간 복기에서 누른 제안 번호 — 프레임 탭이 그 제안으로 스크롤해 강조합니다(탭 단추로 옮기면 지움).
  const [focusProposal, setFocusProposal] = useState<number | null>(null);
  const { data, loading, error, reload, refreshError } = useApi<PaperOverviewResponse>(endpoints.paper.overview, 60_000);
  const current = PAPER_TABS.find((entry) => entry.key === tab) ?? PAPER_TABS[0];
  // 라우터 밖(테스트)에서는 null입니다 — 그때는 주소를 따라가지 않습니다.
  const pathname = usePathname();

  useEffect(() => {
    const fromPath = paperTabFromPath(pathname);
    // 이 화면이 방금 바꾼 주소(replaceState)는 지금 탭과 같아 아무 일도 없습니다. 라우터가 아직 옛 주소를 들고 있는 동안(탭을 막
    // 바꾼 직후)은 브라우저의 지금 주소와 달라 무시합니다 — 그러지 않으면 방금 고른 탭을 옛 주소의 탭으로 되돌립니다.
    if (fromPath === null || fromPath === tab || pathname !== window.location.pathname) return;
    // 주소로 탭을 바꾸는 것은 탭 단추를 누른 것과 같습니다 — 미리 고른 계좌·강조할 제안을 지웁니다.
    setPreselect("");
    setFocusProposal(null);
    setTab(fromPath);
  }, [pathname, tab]);

  /** 탭을 바꾸고 주소를 그 탭의 것으로 — 기록을 쌓지 않는 replaceState(Next 라우터가 usePathname을 맞춰 줌). */
  const showTab = (key: PaperTabKey) => {
    setTab(key);
    const path = paperTabPath(key);
    if (window.location.pathname !== path) window.history.replaceState(null, "", path);
  };
  const openTab = (key: "holdings" | "decisions", code: string) => {
    setPreselect(code);
    setFocusProposal(null);
    showTab(key);
    // 누른 단추는 개요와 함께 사라지므로, 초점을 새 탭 단추로 옮겨 키보드 위치와 화면 위치를 맞춥니다.
    document.getElementById(`paper-tab-${key}`)?.focus();
  };
  const openProposal = (id: number) => {
    setFocusProposal(id);
    showTab("framework");
    document.getElementById("paper-tab-framework")?.focus();
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-bright">모의 알고리즘 매매(미국)</h1>
          <p className="mt-1 text-xs text-muted">
            같은 돈·같은 날 출발한 네 계좌 — 규칙 · Claude · SPY(100%) · 60/40(SPY 60%·SHY 40%)
            {data?.startDate ? ` · 출발 ${data.startDate}` : ""}
          </p>
        </div>
        {/* 자동 갱신이 실패하면 앞서 받은 값을 그대로 보이므로 '새로 읽지 못함'을 붙입니다(QA-104, QA-067과 같음). */}
        <Freshness refreshError={refreshError} />
      </header>

      {/* 시장 고르기(미국 | 한국 · 준비 중 · 2단계)는 셸의 하위 메뉴 줄이 맡습니다(lib/nav) — 화면 안에 또 두면 두 줄로 겹쳐 보였습니다. */}
      {loading && !data && <Loading label="장부를 읽는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {/* 테이블이 아직 없으면 서버 문구 그대로 — 무엇을 하면 생기는지까지 서버가 적어 보냅니다. */}
      {data && !data.available && <Banner tone="warn">{data.message ?? "모의 매매 장부를 읽을 수 없습니다."}</Banner>}

      {data?.available && (
        <>
          {(data.limits ?? []).length > 0 && (
            <Card title="이 장부의 한계" source={PAPER_SOURCES.ledger}>
              <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-body">
                {(data.limits ?? []).map((limit) => (
                  <li key={limit}>{limit}</li>
                ))}
              </ol>
            </Card>
          )}

          <div role="tablist" aria-label="모의 매매 화면" className="flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-1">
            {PAPER_TABS.map((entry) => {
              const active = entry.key === tab;
              return (
                <button
                  key={entry.key}
                  type="button"
                  role="tab"
                  id={`paper-tab-${entry.key}`}
                  aria-selected={active}
                  aria-controls="paper-tabpanel"
                  onClick={() => {
                    setPreselect("");
                    setFocusProposal(null);
                    showTab(entry.key);
                  }}
                  className={`min-h-11 rounded-md px-3 py-1.5 text-xs transition-colors duration-150 motion-reduce:transition-none lg:min-h-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                    active ? "bg-surface-2 font-semibold text-text" : "text-text-2 hover:bg-surface-2 hover:text-text"
                  }`}
                >
                  {entry.label}
                  {entry.opensIn && <span className="ml-1 text-[10px] text-muted">(준비 중)</span>}
                </button>
              );
            })}
          </div>

          <div role="tabpanel" id="paper-tabpanel" aria-labelledby={`paper-tab-${current.key}`} className="flex flex-col gap-6">
            {current.key === "overview" && <OverviewSection overview={data} onChanged={reload} onOpenTab={openTab} />}
            {current.key === "selection" && <SelectionSection />}
            {current.key === "holdings" && <HoldingsSection books={data.books ?? []} onChanged={reload} initialBook={preselect} />}
            {current.key === "decisions" && (
              <DecisionsSection books={data.books ?? []} onChanged={reload} initialBook={preselect} onOpenProposal={openProposal} />
            )}
            {current.key === "framework" && <FrameworkSection focusProposalId={focusProposal} />}
            {current.key === "notes" && <NotesSection startDate={data.startDate ?? null} />}
            {current.key === "settings" && <SettingsSection />}
            {current.opensIn && (
              <Banner tone="info">
                <strong>{current.label}</strong> 탭은 다음 단계에서 엽니다 — {current.opensIn}.
                <p className="mt-1 text-xs">이 탭에 올 것: {current.upcoming}</p>
              </Banner>
            )}
          </div>
        </>
      )}
    </div>
  );
}
