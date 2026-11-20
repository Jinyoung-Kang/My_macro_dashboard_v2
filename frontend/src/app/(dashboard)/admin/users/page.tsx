"use client";

import { FormEvent, useId, useRef, useState } from "react";
import { DataTable, InspectorFrame, InspectorSubheading, InspectorTrigger, PropertyList } from "@/components/patterns";
import { Banner, Button, Callout, ErrorState, FIELD_INPUT, FIELD_LABEL, Loading, NativeSelect, PageHeader, Panel, Select } from "@/components/ui";
import { Dialog } from "@/components/ui/Dialog";
import { CheckIcon, StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { formatKst } from "@/lib/format";
import type { AdminUser, AuditEntry } from "@/lib/types";

type Result = { ok: boolean; message: string };

const ROLE_LABEL: Record<string, string> = { OWNER: "운영자", MEMBER: "회원" };
const TIER_LABEL: Record<string, string> = { FREE: "무료", PRO: "유료" };
/** 검사 칸에 보일 그 사용자의 감사 기록 줄 수(이미 읽은 최근 100건 안에서). */
const AUDIT_LINES = 5;
/** 요청 중 입력칸 — 꺼진 입력칸(공용 inputClasses의 disabled:)과 같은 흐림·커서. 읽기 전용 + aria-disabled일 때만 붙습니다(QA-909). */
const INPUT_BUSY = "aria-disabled:cursor-not-allowed aria-disabled:opacity-60";

/**
 * 사용자 관리(운영자만 — 백엔드 접근 정책이 막음). 결제 연동 전까지 등급은 여기서 정합니다(명세 D4).
 * 바꾼 역할·등급은 그 사용자의 다음 요청부터 반영됩니다.
 *
 * 작업대 P7(실행 명세 §7 7행 '사용자 관리: 속성 목록'): 사용자 표는 공용 조밀 표 + 검사 칸 틀(InspectorFrame lg — 틀 52rem부터 옆 18rem, 그 아래 위쪽 대화상자).
 * 이메일이 검사를 여는 줄 단추이고, 검사 칸은 속성 목록(이메일·역할·등급·메일 인증·가입·사용자 번호)과 그 사용자의 최근 감사 기록(이미 읽은 100건 안 — 새 요청
 * 없음). 표 안 역할·등급 고르기와 운영자로 올리기 대화상자(문구·닫기 단추 없음·비밀번호)는 그대로입니다.
 *
 * 운영자로 올리기 대화상자의 오류(틀린 비밀번호·연속 실패 지연)는 대화상자를 열 때부터 있는 알림 영역(role="alert") 안에 그리고, 비밀번호 입력칸이 그 글로
 * 설명됩니다(QA-868 — 예전에는 보낸 뒤 붙는 보통 상자라 낭독되지 않았음). 보내는 동안 입력칸은 읽기 전용 + aria-disabled, 보내기 단추는 공용 Button busy
 * (aria-disabled)라 포커스가 남고, 실패하면 포커스를 비운 비밀번호 칸으로 옮깁니다(QA-909 — 예전에는 진짜 disabled라 body로). 경로·본문·문구·비밀번호 단계는
 * 그대로입니다. '운영자 비밀번호' 이름표는 이 화면의 다른 폼 칸과 같은 공용 FIELD_LABEL·FIELD_INPUT(13px text-2 — 예전 12px text-3, form-label-styles-mixed의
 * 남은 한 자리)입니다.
 */
export default function AdminUsersPage() {
  const users = useApi<{ users: AdminUser[] }>(endpoints.admin.users, 0);
  const audit = useApi<{ entries: AuditEntry[] }>(endpoints.admin.audit(100), 0);

  // password는 회원을 운영자로 올릴 때만 보냅니다(요청자 계정의 비밀번호 — 서버가 그때만 확인, QA-338).
  const update = useAsyncAction(
    (id: number, role: string, tier: string, password?: string) =>
      apiPost<Result>(endpoints.admin.user(id), password === undefined ? { role, tier } : { role, tier, password }),
    "바꾸지 못했습니다.",
  );
  const create = useAsyncAction(
    (email: string, password: string, tier: string) => apiPost<Result>(endpoints.admin.users, { email, password, tier }),
    "회원을 만들지 못했습니다.",
  );

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tier, setTier] = useState("FREE");

  // 저장하고 목록을 다시 읽을 때까지 그 행의 선택 상자를 막습니다. 그사이 다른 칸을 바꾸면 렌더 시점의 옛 값(역할·등급)을
  // 함께 보내 앞의 변경을 되돌렸습니다(QA-051).
  const [savingId, setSavingId] = useState<number | null>(null);
  // 회원을 운영자로 올리는 선택은 바로 보내지 않고 비밀번호 창을 엽니다(QA-338). tried는 이 창에서 한 번이라도 보냈는지 —
  // 창을 열기 전 다른 변경의 오류 글이 창 안에 보이지 않게 합니다.
  const [promote, setPromote] = useState<{ row: AdminUser; tier: string; tried: boolean } | null>(null);
  const [promotePassword, setPromotePassword] = useState("");
  // 대화상자 안 오류 — 이 창에서 보낸 뒤에만(창을 열기 전 다른 변경의 오류는 보이지 않게).
  const promoteError = promote?.tried && !update.busy ? update.error : null;
  const promoteErrorId = useId();
  const promoteInput = useRef<HTMLInputElement>(null);
  const save = async (row: AdminUser, role: string, nextTier: string, ownerPassword?: string): Promise<boolean> => {
    setSavingId(row.id);
    let ok = false;
    try {
      ok = await update.run(row.id, role, nextTier, ownerPassword);
      await users.reload();
    } finally {
      setSavingId(null);
    }
    void audit.reload();
    return ok;
  };
  const change = async (row: AdminUser, role: string, nextTier: string) => {
    if (role === "OWNER" && row.role !== "OWNER") {
      setPromotePassword("");
      setPromote({ row, tier: nextTier, tried: false });
      return;
    }
    await save(row, role, nextTier);
  };
  const confirmPromote = async (event: FormEvent) => {
    event.preventDefault();
    if (!promote || !promotePassword || update.busy) return;
    setPromote({ ...promote, tried: true });
    // 성공하면 닫고, 실패(틀린 비밀번호·연속 실패 지연)면 창을 둔 채 오류를 보입니다 — 비밀번호는 다시 치게 비웁니다.
    const ok = await save(promote.row, "OWNER", promote.tier, promotePassword);
    setPromotePassword("");
    if (ok) setPromote(null);
    // 실패면 다시 칠 비밀번호 칸으로 — 비운 칸이라 보내기 단추가 켜짐 조건으로 꺼지고, 그 단추에 있던 포커스가 body로 떨어졌습니다(QA-909).
    else promoteInput.current?.focus();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // 요청 중이면 다시 보내지 않습니다 — 단추는 요청 동안 aria-disabled라(QA-899) 입력칸 Enter의 폼 보내기를 막지 못합니다.
    if (create.busy) return;
    // 성공했을 때만 비밀번호 칸을 비웁니다. 실패(메일 중복·형식 오류·연결 끊김)에도 지워 고쳐 다시 보내려면 처음부터
    // 다시 쳐야 했습니다(QA-105, 내 계정의 QA-051과 같음).
    if (await create.run(email, password, tier)) setPassword("");
    void users.reload();
    void audit.reload();
  };

  if (users.loading && !users.data) return <Loading label="사용자 목록을 읽는 중…" />;
  if (users.error) return <ErrorState message={users.error} onRetry={users.reload} />;

  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <PageHeader title="사용자 관리" description="역할(운영자·회원)과 등급(무료·유료)을 정합니다. 자기 운영자 역할은 내릴 수 없습니다." />

      <Panel title="사용자" count={`${users.data?.users.length ?? 0}명`}>
        {update.error && (
          <div className="mb-3">
            <Callout tone="warn">{update.error}</Callout>
          </div>
        )}
        {update.result && (
          <div className="mb-3">
            <Callout tone={update.result.ok ? "ok" : "warn"}>{update.result.message}</Callout>
          </div>
        )}
        <UsersTable
          users={users.data?.users ?? []}
          audit={audit.data?.entries ?? null}
          auditLoading={audit.loading && !audit.data}
          savingId={savingId}
          onChange={(row, role, tier) => void change(row, role, tier)}
        />
      </Panel>

      <Dialog
        open={promote !== null}
        onOpenChange={(open) => {
          if (!open && !update.busy) setPromote(null);
        }}
        title="운영자로 올리기"
        description={
          <>
            <span className="font-medium text-text">{promote?.row.email}</span> 회원을 운영자로 올립니다. 운영자는 모든 설정과 실제 매매
            화면을 쓸 수 있습니다. 계속하려면 지금 운영자 계정의 비밀번호를 입력하세요(로그인 없이 연 화면에서는 첫 운영자 계정의 비밀번호).
          </>
        }
        size="sm"
        dismissible={!update.busy}
        showClose={false}
      >
        <form onSubmit={confirmPromote} className="mt-4 flex flex-col gap-3" aria-busy={update.busy}>
          {/* 입력칸과 알림 영역을 한 칸으로 묶어, 빈 영역이 폼 간격(gap-3)을 하나 더 만들지 않게 합니다 — 오류가 있을 때만 12px 위 여백(예전 간격과 같음). */}
          <div className="flex flex-col">
            <label className={FIELD_LABEL}>
              운영자 비밀번호
              <input ref={promoteInput} type="password" autoComplete="off" value={promotePassword}
                readOnly={update.busy} aria-disabled={update.busy || undefined}
                aria-describedby={promoteError ? promoteErrorId : undefined}
                onChange={(event) => setPromotePassword(event.target.value)}
                className={`${FIELD_INPUT}${update.busy ? ` ${INPUT_BUSY}` : ""}`} />
            </label>
            <div role="alert">
              {promoteError && (
                <div id={promoteErrorId} className="mt-3">
                  <Banner tone="warn">{promoteError}</Banner>
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" type="button" disabled={update.busy} onClick={() => setPromote(null)}>취소</Button>
            <Button variant="primary" type="submit" busy={update.busy} disabled={!promotePassword}>
              {update.busy ? "확인하는 중…" : "운영자로 올리기"}
            </Button>
          </div>
        </form>
      </Dialog>

      <Panel title="회원 만들기" subtitle="메일 없이 인증된 회원을 만듭니다. 처음 비밀번호는 직접 전달하고, 회원이 내 계정에서 바꾸도록 안내하세요.">
        <form onSubmit={submit} className="flex max-w-md flex-col gap-3">
          <label className={FIELD_LABEL}>
            이메일
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)}
              className={FIELD_INPUT} />
          </label>
          <label className={FIELD_LABEL}>
            처음 비밀번호(10자 이상)
            <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)}
              className={FIELD_INPUT} />
          </label>
          <Select label="등급" value={tier} onChange={setTier}
            options={[{ value: "FREE", label: "무료" }, { value: "PRO", label: "유료" }]} />
          {create.error && <Callout tone="warn">{create.error}</Callout>}
          {create.result && <Callout tone={create.result.ok ? "ok" : "warn"}>{create.result.message}</Callout>}
          <Button variant="primary" type="submit" disabled={!email || !password} busy={create.busy}>
            {create.busy ? "만드는 중…" : "회원 만들기"}
          </Button>
        </form>
      </Panel>

      <Panel title="감사 기록" subtitle="로그인·비밀번호·역할/등급 변경·계정 삭제(최근 100건). 비밀번호·토큰 값은 남기지 않습니다.">
        {audit.error && <ErrorState message={audit.error} onRetry={audit.reload} />}
        <DataTable
          dense
          count
          scrollHint="overflow"
          caption="감사 기록"
          // 같은 시각 기록이 겹쳐도 갈리게 차례를 붙입니다(예전 표의 '{시각}-{차례}' 키와 같음).
          rows={(audit.data?.entries ?? []).map((row, index) => ({ ...row, key: `${row.at}-${index}` }))}
          rowKey={(row) => row.key}
          columns={[
            { key: "at", header: "시각", className: "whitespace-nowrap", cell: (row) => formatKst(row.at) },
            { key: "user", header: "사용자 번호", align: "right", cell: (row) => (row.userId === null ? null : String(row.userId)) },
            { key: "action", header: "동작", className: "whitespace-nowrap", cell: (row) => <span className="font-mono text-caption">{row.action}</span> },
            { key: "detail", header: "내용", className: "min-w-[16rem] break-keep wrap-anywhere text-caption text-text-2", cell: (row) => row.detail },
          ]}
        />
      </Panel>
    </div>
  );
}

/**
 * 사용자 표 + 검사 칸. 줄 단추는 이메일(공용 줄 단추 — 중립 잉크, 좁은 화면 44px). 역할·등급은 표 안 작은 고르기(보이지 않는 이름 — QA-848), 메일 인증은
 * 상태 글(아이콘 + 글). 검사 칸은 이미 읽은 사용자·감사 응답만 씁니다(새 요청 0).
 */
function UsersTable({
  users,
  audit,
  auditLoading,
  savingId,
  onChange,
}: {
  users: readonly AdminUser[];
  audit: readonly AuditEntry[] | null;
  /** 감사 기록을 아직 읽는 중(받은 것 없음) — 검사 칸이 '받지 못함'과 가름(QA-874). */
  auditLoading: boolean;
  savingId: number | null;
  onChange: (row: AdminUser, role: string, tier: string) => void;
}) {
  const byKey = new Map(users.map((row) => [String(row.id), row]));
  return (
    <InspectorFrame
      label="사용자"
      layout="lg"
      titleOf={(key) => byKey.get(key)?.email ?? null}
      inspectorHint="이메일을 고르면 이 칸에 그 사용자의 속성과 최근 감사 기록이 나옵니다."
      renderDetail={(key) => {
        const row = byKey.get(key);
        return row ? <UserDetail row={row} audit={audit} auditLoading={auditLoading} /> : null;
      }}
    >
      {(inspector) => (
        <DataTable<AdminUser>
          dense
          caption="사용자"
          rows={users}
          rowKey={(row) => String(row.id)}
          selectedKey={inspector.shownKey}
          scrollHint="overflow"
          columns={[
            {
              key: "email",
              header: "이메일",
              rowHeader: true,
              className: "break-keep",
              cell: (row) => (
                <InspectorTrigger inspector={inspector} itemKey={String(row.id)} className="wrap-anywhere">
                  {row.email}
                </InspectorTrigger>
              ),
            },
            // 표 안 고르기는 보이는 이름표 없이 보이지 않는 이름('{이메일} 역할|등급')만 — 보이는 이름표를 그리면 한 행에 이메일이 세 번 찍혔습니다(QA-848).
            // 머리 칸('역할'·'등급')과 같은 행의 이메일 칸이 보이는 이름을 대신합니다.
            {
              key: "role",
              header: "역할",
              cell: (row) => (
                <NativeSelect
                  aria-label={`${row.email} 역할`}
                  inputSize="sm"
                  value={row.role}
                  disabled={savingId === row.id}
                  onChange={(event) => onChange(row, event.target.value, row.tier)}
                >
                  <option value="OWNER">운영자</option>
                  <option value="MEMBER">회원</option>
                </NativeSelect>
              ),
            },
            {
              key: "tier",
              header: "등급",
              cell: (row) => (
                <NativeSelect
                  aria-label={`${row.email} 등급`}
                  inputSize="sm"
                  value={row.tier}
                  disabled={savingId === row.id}
                  onChange={(event) => onChange(row, row.role, event.target.value)}
                >
                  <option value="FREE">무료</option>
                  <option value="PRO">유료</option>
                </NativeSelect>
              ),
            },
            { key: "verified", header: "메일 인증", className: "whitespace-nowrap", cell: (row) => <Verified verified={row.verified} /> },
            { key: "created", header: "가입", className: "whitespace-nowrap", cell: (row) => formatKst(row.createdAt) },
          ]}
        />
      )}
    </InspectorFrame>
  );
}

/** 메일 인증 — 인증됨은 정상 체크 아이콘 + 글, 대기는 중립 아이콘 + 글(예전 아이콘만·글만). */
function Verified({ verified }: { verified: boolean }) {
  return verified ? (
    <StatusText tone="ok" icon={<CheckIcon size={14} />}>
      인증됨
    </StatusText>
  ) : (
    <StatusText tone="neutral">대기</StatusText>
  );
}

/**
 * 사용자 검사 칸 — 속성 목록 + 그 사용자의 최근 감사 기록(이미 읽은 최근 100건 안에서, 최근 다섯 줄). 감사 기록이 아직 없으면 읽는 중('불러오는 중')과
 * 실패('받지 못했습니다')를 가릅니다 — 예전에는 둘 다 '받지 못했습니다'였습니다(QA-874).
 */
function UserDetail({ row, audit, auditLoading }: { row: AdminUser; audit: readonly AuditEntry[] | null; auditLoading: boolean }) {
  const lines = (audit ?? []).filter((entry) => entry.userId === row.id).slice(0, AUDIT_LINES);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PropertyList
        dense
        items={[
          { label: "이메일", value: row.email },
          { label: "역할", value: ROLE_LABEL[row.role] ?? row.role },
          { label: "등급", value: TIER_LABEL[row.tier] ?? row.tier },
          { label: "메일 인증", value: <Verified verified={row.verified} /> },
          { label: "가입", value: formatKst(row.createdAt) },
          { label: "사용자 번호", value: String(row.id), mono: true },
        ]}
      />
      <div className="min-w-0">
        <InspectorSubheading fallback="h4" className="mb-1 text-caption font-semibold text-text-2">
          최근 감사 기록
        </InspectorSubheading>
        {audit === null ? (
          <p className="text-sm text-text-3">{auditLoading ? "감사 기록을 불러오는 중입니다." : "감사 기록을 받지 못했습니다."}</p>
        ) : lines.length === 0 ? (
          <p className="break-keep text-sm text-text-3">최근 100건 안에 이 사용자의 기록이 없습니다.</p>
        ) : (
          <ul className="flex flex-col">
            {lines.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="border-b border-border-subtle py-1.5 text-caption last:border-0">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="whitespace-nowrap tabular-nums text-text-3">{formatKst(entry.at)}</span>
                  <span className="font-mono text-text">{entry.action}</span>
                </span>
                {entry.detail ? <span className="block break-keep wrap-anywhere text-text-2">{entry.detail}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
