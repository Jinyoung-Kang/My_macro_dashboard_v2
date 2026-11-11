"use client";

import { FormEvent, useState } from "react";
import { Banner, Button, Card, ErrorState, inputClasses, Loading, PageHeader, Select, Table } from "@/components/ui";
import { Dialog } from "@/components/ui/Dialog";
import { CheckIcon, StatusIcon } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { formatKst } from "@/lib/format";
import type { AdminUser, AuditEntry } from "@/lib/types";

type Result = { ok: boolean; message: string };

/**
 * 사용자 관리(운영자만 — 백엔드 접근 정책이 막음). 결제 연동 전까지 등급은 여기서 정합니다(명세 D4).
 * 바꾼 역할·등급은 그 사용자의 다음 요청부터 반영됩니다.
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
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // 성공했을 때만 비밀번호 칸을 비웁니다. 실패(메일 중복·형식 오류·연결 끊김)에도 지워 고쳐 다시 보내려면 처음부터
    // 다시 쳐야 했습니다(QA-105, 내 계정의 QA-051과 같음).
    if (await create.run(email, password, tier)) setPassword("");
    void users.reload();
    void audit.reload();
  };

  if (users.loading && !users.data) return <Loading label="사용자 목록을 읽는 중…" />;
  if (users.error) return <ErrorState message={users.error} onRetry={users.reload} />;

  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <PageHeader title="사용자 관리" description="역할(운영자·회원)과 등급(무료·유료)을 정합니다. 자기 운영자 역할은 내릴 수 없습니다." />

      <Card title="사용자" subtitle={`${users.data?.users.length ?? 0}명`}>
        {update.error && <Banner tone="warn">{update.error}</Banner>}
        {update.result && <Banner tone={update.result.ok ? "info" : "warn"}>{update.result.message}</Banner>}
        <Table<AdminUser>
          rows={users.data?.users ?? []}
          rowKey={(row) => String(row.id)}
          columns={[
            { key: "email", header: "이메일", render: (row) => row.email },
            {
              key: "role",
              header: "역할",
              render: (row) => (
                <Select
                  label={`${row.email} 역할`}
                  value={row.role}
                  disabled={savingId === row.id}
                  onChange={(value) => void change(row, value, row.tier)}
                  options={[{ value: "OWNER", label: "운영자" }, { value: "MEMBER", label: "회원" }]}
                />
              ),
            },
            {
              key: "tier",
              header: "등급",
              render: (row) => (
                <Select
                  label={`${row.email} 등급`}
                  value={row.tier}
                  disabled={savingId === row.id}
                  onChange={(value) => void change(row, row.role, value)}
                  options={[{ value: "FREE", label: "무료" }, { value: "PRO", label: "유료" }]}
                />
              ),
            },
            {
              key: "verified",
              header: "메일 인증",
              render: (row) => (row.verified ? <StatusIcon tone="ok" label="인증됨" icon={<CheckIcon size={16} />} /> : "대기"),
            },
            { key: "created", header: "가입", render: (row) => formatKst(row.createdAt) },
          ]}
        />
      </Card>

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
          <label className="text-xs text-muted">
            운영자 비밀번호
            <input type="password" autoComplete="off" value={promotePassword} disabled={update.busy}
              onChange={(event) => setPromotePassword(event.target.value)}
              className={`mt-1 w-full ${inputClasses()}`} />
          </label>
          {promote?.tried && !update.busy && update.error && <Banner tone="warn">{update.error}</Banner>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" type="button" disabled={update.busy} onClick={() => setPromote(null)}>취소</Button>
            <Button variant="primary" type="submit" disabled={update.busy || !promotePassword}>
              {update.busy ? "확인하는 중…" : "운영자로 올리기"}
            </Button>
          </div>
        </form>
      </Dialog>

      <Card title="회원 만들기" subtitle="메일 없이 인증된 회원을 만듭니다. 처음 비밀번호는 직접 전달하고, 회원이 내 계정에서 바꾸도록 안내하세요.">
        <form onSubmit={submit} className="flex max-w-sm flex-col gap-3">
          <label className="text-xs text-muted">
            이메일
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)}
              className={`mt-1 w-full ${inputClasses()}`} />
          </label>
          <label className="text-xs text-muted">
            처음 비밀번호(10자 이상)
            <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)}
              className={`mt-1 w-full ${inputClasses()}`} />
          </label>
          <Select label="등급" value={tier} onChange={setTier}
            options={[{ value: "FREE", label: "무료" }, { value: "PRO", label: "유료" }]} />
          {create.error && <Banner tone="warn">{create.error}</Banner>}
          {create.result && <Banner tone={create.result.ok ? "info" : "warn"}>{create.result.message}</Banner>}
          <Button variant="primary" type="submit" disabled={create.busy || !email || !password}>
            {create.busy ? "만드는 중…" : "회원 만들기"}
          </Button>
        </form>
      </Card>

      <Card title="감사 기록" subtitle="로그인·비밀번호·역할/등급 변경·계정 삭제(최근 100건). 비밀번호·토큰 값은 남기지 않습니다.">
        {audit.error && <ErrorState message={audit.error} onRetry={audit.reload} />}
        <Table<AuditEntry>
          rows={audit.data?.entries ?? []}
          rowKey={(row, index) => `${row.at}-${index}`}
          columns={[
            { key: "at", header: "시각", render: (row) => formatKst(row.at) },
            { key: "user", header: "사용자 번호", render: (row) => (row.userId === null ? "—" : String(row.userId)) },
            { key: "action", header: "동작", render: (row) => row.action },
            { key: "detail", header: "내용", render: (row) => <span className="text-xs text-muted">{row.detail}</span> },
          ]}
        />
      </Card>
    </div>
  );
}
