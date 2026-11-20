"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useId, useRef, useState } from "react";
import { DataTable, PropertyList } from "@/components/patterns";
import { Button, Callout, ErrorState, inputClasses, Loading, PageHeader, Panel } from "@/components/ui";
import { StatusDot, StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useSessionUser } from "@/hooks/useSessionUser";
import { isDemo, isLocalOwner, noLoginName, roleLabel } from "@/lib/access";
import { auth } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { formatKst } from "@/lib/format";
import type { LoginSession, SessionResponse } from "@/lib/types";

/**
 * 내 계정 — 계정 정보, 비밀번호 변경, 로그인한 기기(세션) 목록과 "다른 기기 모두 로그아웃".
 *
 * 비밀번호를 바꾸면 백엔드가 다른 기기의 세션을 끊습니다(지금 기기는 남김, ADR 0010).
 * 데모 열람(ADR 0013)은 계정이 없으므로 대시보드 첫 화면으로 보냅니다.
 * 로그인 없이 연 로컬 운영자(ADR 0016)는 세션(쿠키)이 없어 로그인한 기기 목록·다른 기기 로그아웃을 숨기고,
 * 비밀번호 변경만 둡니다 — 그 비밀번호는 웹·QA 스택이나 이 DB를 복원한 백업에서 로그인할 때 씁니다.
 *
 * 작업대 P7(실행 명세 §7 7행 '내 계정: 속성 목록'): 머리 설명 대신 '계정' 속성 목록(이메일·역할·등급·로그인 방식), 안내는 중립 안내 상자, 폼 이름표는 공용 고르기
 * 상자와 같은 13px text-2·입력칸 폭 상한 22rem, 로그인한 기기는 공용 조밀 표. 쓰기(비밀번호 변경·다른 기기 로그아웃·계정 지우기 확인 창 문구)는 그대로입니다.
 *
 * 낭독(QA-867 — 문구·요청·켜짐 조건 그대로): 비밀번호 불일치면 확인 입력칸이 aria-invalid이고 불일치 글로 aria-describedby, 서버 오류 상자는 role="alert"
 * 안에 그립니다. 성공 결과(비밀번호 변경·다른 기기 로그아웃)는 패널마다 늘 있는 조용한 알림 영역(눈에 보이지 않는 role="status" — 붙자마자 글이 든 영역은
 * 낭독기가 놓치므로 영역을 먼저 둠)이 보이는 결과 상자와 같은 글로 읽습니다. 계정 지우기가 성공해 폼이 결과 상자로 바뀌면 포커스를 그 상자로 옮깁니다
 * (포커스가 있던 단추가 사라져 <body>로 떨어졌음).
 */

/** 폼 이름표 — 공용 고르기 상자(Select)와 같은 13px 보조 글(text-2), 위 이름표·아래 칸(form-label-styles-mixed의 이 화면 몫 — 예전 12px text-3). */
const FIELD_LABEL = "flex min-w-0 flex-col gap-1 text-[13px] text-text-2";
/** 한 줄 입력칸 — 고르기 상자와 같은 폭 상한(sm 이상 22rem). */
const FIELD_INPUT = `w-full sm:max-w-[22rem] ${inputClasses()}`;

/** 결과·오류를 낭독기에 알리는 조용한 영역 — 눈에 보이지 않고(sr-only — 절대 위치라 flex 간격에 들지 않음) 늘 있어 글이 바뀔 때 읽힙니다. */
function ResultAnnouncer({ text }: { text: string | null | undefined }) {
  return (
    <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {text ?? ""}
    </p>
  );
}

/** 등급 이름 — 모르는 값은 받은 글 그대로. */
const TIER_LABEL: Record<string, string> = { FREE: "무료", PRO: "유료" };
export default function AccountPage() {
  const router = useRouter();
  const sessionUser = useSessionUser();
  const demo = isDemo(sessionUser);
  const session = useApi<SessionResponse>(demo ? null : endpoints.auth.session, 0, { followRefresh: false });
  const user = session.data?.user;
  // 레이아웃이 내려 준 사용자로 먼저 압니다. 세션 응답을 기다리면 그 사이 기기 목록을 한 번 부릅니다.
  const local = isLocalOwner(sessionUser) || isLocalOwner(user);
  const sessions = useApi<{ sessions: LoginSession[] }>(demo || local ? null : endpoints.auth.sessions, 0);

  useEffect(() => {
    if (demo) router.replace("/");
  }, [demo, router]);

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const change = useAsyncAction(auth.changePassword, "비밀번호를 바꾸지 못했습니다.");
  const others = useAsyncAction(auth.logoutOthers, "다른 기기 로그아웃에 실패했습니다.");

  const mismatch = confirm.length > 0 && next !== confirm;
  const mismatchId = useId();
  const [deletePassword, setDeletePassword] = useState("");
  const remove = useAsyncAction(auth.deleteAccount, "계정을 지우지 못했습니다.");
  // 계정 지우기가 성공해 폼이 결과 상자로 바뀌면 포커스를 그 상자로(QA-867).
  const removedRef = useRef<HTMLDivElement>(null);
  const removed = Boolean(remove.result?.ok);
  useEffect(() => {
    if (removed) removedRef.current?.focus();
  }, [removed]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // 요청 중이면 다시 보내지 않습니다 — 단추는 요청 동안 aria-disabled라(QA-899) 입력칸 Enter의 폼 보내기를 막지 못합니다.
    if (mismatch || change.busy) return;
    // 실패하면(지금 비밀번호 틀림 등) 입력을 남겨 고쳐 다시 보낼 수 있게 합니다(QA-051).
    if (await change.run(current, next)) {
      setCurrent("");
      setNext("");
      setConfirm("");
    }
    void sessions.reload();
  };

  if (demo) return <Loading label="대시보드로 이동하는 중…" />;
  if (session.loading && !session.data) return <Loading label="계정 정보를 읽는 중…" />;
  if (session.error) return <ErrorState message={session.error} onRetry={session.reload} />;

  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <PageHeader title="내 계정" />

      <Panel title="계정">
        <div className="max-w-md">
          <PropertyList
            dense
            items={[
              { label: "이메일", value: user?.email ?? null },
              { label: "역할", value: roleLabel(user) || null },
              { label: "등급", value: user?.tier ? (TIER_LABEL[user.tier] ?? user.tier) : null },
              { label: "로그인 방식", value: local ? noLoginName(user) : user ? "이메일·비밀번호(세션)" : null },
            ]}
          />
        </div>
      </Panel>

      {local && (
        <Callout>
          {noLoginName(user)} — {user?.tailnet
            ? "Tailscale 계정(운영자로 정한 사용자)으로 연 서버 화면이라"
            : "이 컴퓨터(localhost)에서 연 로컬 실행이라"} 로그인 없이 이 운영자 계정으로 열렸습니다.
          로그인 세션이 없어 로그아웃·로그인한 기기 목록이 없습니다.
        </Callout>
      )}

      <Panel
        title="비밀번호 변경"
        subtitle={
          local
            ? "로컬은 로그인 없이 열리지만, 이 비밀번호는 웹·QA 스택에서 로그인하거나 이 DB의 백업을 복원했을 때 씁니다. 10자 이상, 흔한 비밀번호·이메일을 담은 비밀번호는 쓸 수 없습니다."
            : "10자 이상, 흔한 비밀번호·이메일을 담은 비밀번호는 쓸 수 없습니다. 바꾸면 다른 기기의 로그인은 끊깁니다."
        }
      >
        <form onSubmit={submit} className="flex max-w-sm flex-col gap-3">
          {[
            { label: "지금 비밀번호", value: current, set: setCurrent, auto: "current-password", checked: false },
            { label: "새 비밀번호", value: next, set: setNext, auto: "new-password", checked: false },
            { label: "새 비밀번호 확인", value: confirm, set: setConfirm, auto: "new-password", checked: true },
          ].map((field) => (
            <label key={field.label} className={FIELD_LABEL}>
              {field.label}
              <input
                type="password"
                value={field.value}
                autoComplete={field.auto}
                onChange={(event) => field.set(event.target.value)}
                aria-invalid={field.checked && mismatch ? true : undefined}
                aria-describedby={field.checked && mismatch ? mismatchId : undefined}
                className={FIELD_INPUT}
              />
            </label>
          ))}
          {/* 위험은 색만이 아니라 아이콘 + 글(낭독 머리말 '오류:') — 위험색은 상승 빨강과 색만으로 갈리지 않음(QA-849). 확인 입력칸이 이 글로 설명됨(QA-867). */}
          {mismatch && (
            <p id={mismatchId} className="text-xs">
              <StatusText tone="danger" iconSize={12}>새 비밀번호가 서로 다릅니다.</StatusText>
            </p>
          )}
          {change.error && (
            <div role="alert">
              <Callout tone="warn">{change.error}</Callout>
            </div>
          )}
          {change.result?.ok && <Callout tone="ok">{change.result.message}</Callout>}
          <ResultAnnouncer text={change.result?.ok ? change.result.message : null} />
          <Button
            variant="primary"
            type="submit"
            disabled={!current || !next || mismatch}
            busy={change.busy}
          >
            {change.busy ? "바꾸는 중…" : "비밀번호 바꾸기"}
          </Button>
        </form>
      </Panel>

      {user?.role !== "OWNER" && (
        <Panel title="계정 삭제" subtitle="계정과 개인정보(이메일·로그인 기기·알림 설정)를 바로 지웁니다. 되돌릴 수 없습니다.">
          {remove.result?.ok ? (
            <div ref={removedRef} tabIndex={-1} className="outline-none">
              <Callout tone="ok">
                {remove.result.message}{" "}
                <a href="/login" className="underline">
                  로그인 화면으로
                </a>
              </Callout>
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (remove.busy) return;
                if (window.confirm("계정을 지울까요? 되돌릴 수 없습니다.")) void remove.run(deletePassword);
              }}
              className="flex max-w-sm flex-col gap-3"
            >
              <label className={FIELD_LABEL}>
                비밀번호 확인
                <input
                  type="password"
                  value={deletePassword}
                  autoComplete="current-password"
                  onChange={(event) => setDeletePassword(event.target.value)}
                  className={FIELD_INPUT}
                />
              </label>
              {remove.error && (
                <div role="alert">
                  <Callout tone="warn">{remove.error}</Callout>
                </div>
              )}
              <Button type="submit" disabled={!deletePassword} busy={remove.busy}>
                {remove.busy ? "지우는 중…" : "계정 지우기"}
              </Button>
            </form>
          )}
        </Panel>
      )}

      {/* 세션(쿠키)이 없는 로컬 운영자는 목록이 늘 비고, 다른 기기 로그아웃도 뜻이 없습니다. */}
      {!local && (
        <Panel
          title="로그인한 기기"
          subtitle="이 계정으로 로그인돼 있는 세션입니다. 모르는 기기가 있으면 다른 기기를 모두 로그아웃하고 비밀번호를 바꾸세요."
          actions={
            <Button
              onClick={async () => {
                await others.run();
                void sessions.reload();
              }}
              busy={others.busy}
            >
              {others.busy ? "처리 중…" : "다른 기기 모두 로그아웃"}
            </Button>
          }
        >
          {others.result && <Callout tone="ok">다른 기기 {others.result.revoked}곳의 로그인을 끊었습니다.</Callout>}
          {others.error && (
            <div role="alert">
              <Callout tone="warn">{others.error}</Callout>
            </div>
          )}
          <ResultAnnouncer text={others.result ? `다른 기기 ${others.result.revoked}곳의 로그인을 끊었습니다.` : null} />
          {sessions.error && <ErrorState message={sessions.error} onRetry={sessions.reload} />}
          {sessions.loading && !sessions.data && <Loading />}
          {/* 목록을 받기 전에는 '로그인한 기기가 없습니다'가 아닙니다(QA-050). */}
          {sessions.data && (
            <DataTable<LoginSession>
              dense
              count
              scrollHint="overflow"
              caption="로그인한 기기 목록"
              rows={sessions.data?.sessions ?? []}
              rowKey={(row) => row.id}
              emptyText="로그인한 기기가 없습니다."
              columns={[
                {
                  key: "device",
                  header: "기기",
                  rowHeader: true,
                  className: "min-w-[14rem] break-keep wrap-anywhere",
                  cell: (row) =>
                    row.current ? (
                      // 점은 장식 — 뜻은 '지금 이 기기' 글이 나릅니다.
                      <span className="inline-flex items-center gap-1.5">
                        <StatusDot tone="ok" />
                        지금 이 기기
                      </span>
                    ) : (
                      row.userAgent ?? "알 수 없음"
                    ),
                },
                { key: "lastSeen", header: "마지막 사용", className: "whitespace-nowrap", cell: (row) => formatKst(row.lastSeenAt) },
                { key: "created", header: "로그인", className: "whitespace-nowrap", cell: (row) => formatKst(row.createdAt) },
                { key: "expires", header: "만료", className: "whitespace-nowrap", cell: (row) => formatKst(row.expiresAt) },
              ]}
            />
          )}
        </Panel>
      )}
    </div>
  );
}
