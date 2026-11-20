import Link from "next/link";
import type { ReactNode, Ref } from "react";
import { AUTH_CARD, AUTH_LINK, AUTH_MESSAGE, AUTH_MESSAGE_TONE, AUTH_SUBMIT, AUTH_TITLE } from "@/components/auth/classes";
import { inputClasses } from "@/components/ui/classes";
import { StatusText } from "@/components/ui/icons";

/**
 * 로그인 밖 화면(로그인·가입·인증·재설정·처리방침)의 공통 틀 — 화면 가운데 카드 하나(4px 모서리, 안쪽 24px), 제목 20px,
 * 입력칸·주 단추는 큰 조작(넓은 화면 40px, 좁은 화면 44px), 주 단추는 폭 전체 강조 파랑(명세 §7-3 배치, 작업대 화면 언어 겉모양).
 * 클래스는 서버 컴포넌트(/privacy)도 쓰므로 순수 모듈에서 가져옵니다.
 */
export function AuthCard({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className={AUTH_CARD}>
        <h1 className={AUTH_TITLE}>{title}</h1>
        {children}
        <div className="mt-6 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-text-2">
          {footer ?? <Link href="/login" className={AUTH_LINK}>← 로그인</Link>}
        </div>
      </div>
    </main>
  );
}

/**
 * 입력 칸 하나.
 *
 * @param invalid 화면이 아는 입력 탓의 오류(비밀번호 불일치·로그인이 받지 않은 값)가 있을 때 — aria-invalid(QA-868).
 * @param describedBy 이 칸을 설명하는 오류 글의 id(aria-describedby, 빈칸으로 여럿) — 칸으로 돌아오면 오류 글이 함께 읽힙니다(QA-868).
 */
export function AuthField({
  label, type = "text", value, onChange, autoComplete, autoFocus, invalid = false, describedBy,
}: {
  label: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  autoFocus?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  return (
    <label className="mt-4 block text-[13px] font-medium text-text-2">
      {label}
      <input
        type={type}
        value={value}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy || undefined}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1.5 w-full ${inputClasses("lg")}`}
      />
    </label>
  );
}

/**
 * 결과 상자(오류·성공) — 공용 상태 글(StatusText)이라 오류는 위험 톤 아이콘과 낭독기 머리말 '오류: ', 성공은 정상 톤 체크 아이콘이 글 앞에 붙습니다
 * (색만으로 가르지 않음 — QA-855). 아이콘은 순수 SVG(components/ui/icons)라 서버 컴포넌트에서도 그릴 수 있습니다.
 *
 * 낭독(QA-868): 폼이 남는 오류는 AuthAlert 안에 그리고 입력칸이 `id`로 가리킵니다. 폼·대기 글이 이 상자로 바뀌는 결과(가입·재설정 성공, 메일 인증)는
 * `focusRef`를 받아 포커스를 받는 상자(tabIndex -1, 링 없음 — 글 상자라 누르는 것처럼 보이지 않게)가 되고, 화면이 포커스를 옮겨 낭독기가 읽습니다.
 * 훅을 쓰지 않습니다 — 이 파일은 서버 컴포넌트(/privacy)도 가져옵니다.
 */
export function AuthMessage({
  tone, children, id, focusRef,
}: {
  tone: "error" | "ok";
  children: ReactNode;
  id?: string;
  focusRef?: Ref<HTMLParagraphElement>;
}) {
  return (
    <p
      id={id}
      ref={focusRef}
      tabIndex={focusRef ? -1 : undefined}
      className={`${AUTH_MESSAGE} ${AUTH_MESSAGE_TONE[tone]}${focusRef ? " outline-none" : ""}`}
    >
      <StatusText tone={tone === "error" ? "danger" : "ok"}>{children}</StatusText>
    </p>
  );
}

/**
 * 오류 글의 알림 자리 — 처음부터 늘 DOM에 있는 role="alert" 영역이고, 오류 상자(AuthMessage)는 그 안에 그립니다(QA-868). 붙자마자 글이 든 영역은
 * 낭독기가 놓치므로 영역을 먼저 두고 안의 글만 바꿉니다. 빈 영역은 자리를 차지하지 않습니다(카드 안은 블록 흐름 — 여백은 안의 상자가 가짐).
 * 같은 오류를 다시 받아도 화면이 보낼 때 오류를 비웠다가 다시 넣으므로 다시 읽힙니다.
 */
export function AuthAlert({ children }: { children?: ReactNode }) {
  return <div role="alert">{children}</div>;
}

/**
 * 서버가 보낸 입력을 받지 않았다는 오류인가 — 로그인이 받지 않은 이메일·비밀번호(401)만. 입력칸의 aria-invalid는 화면이 아는 입력 탓에만 붙입니다
 * (연결 실패·서버 오류·너무 잦은 시도는 입력 탓이 아님 — 그때는 오류 글로 설명만). 시험이 api 모듈을 통째로 흉내 내도 되게 오류 클래스 대신 status를 봅니다.
 */
export function credentialsRejected(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 401;
}

/** 입력 칸 아래의 오류 글(비밀번호 불일치) — 12px, 위험 톤 아이콘 + 낭독기 머리말 + 글(QA-855). 확인 입력칸이 `id`로 가리킵니다(QA-868). */
export function AuthFieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-2 text-xs">
      <StatusText tone="danger" iconSize={12}>
        {children}
      </StatusText>
    </p>
  );
}

export function AuthSubmit({ busy, disabled, children }: { busy: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="submit" disabled={busy || disabled} className={AUTH_SUBMIT}>
      {busy ? "처리 중…" : children}
    </button>
  );
}
