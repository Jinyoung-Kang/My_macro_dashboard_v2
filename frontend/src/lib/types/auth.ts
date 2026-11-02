/** 로그인한 사용자 — GET /api/auth/session의 user. 막는 것은 백엔드이고, 화면은 메뉴를 고르는 데만 씁니다. */
export interface SessionUser {
  /** 데모 열람이면 null(계정이 없음). */
  email: string | null;
  role: "OWNER" | "MEMBER";
  tier: "FREE" | "PRO";
  /**
   * 데모 열람(ADR 0013) — AWS 공개 데모에서 접근 코드를 통과한 방문자. 계정·세션 없이 읽기 전용이라
   * 로그아웃·내 계정·쓰기 버튼을 숨기거나 막습니다(백엔드도 GET 밖은 403).
   */
  demo?: boolean;
  /**
   * 로그인 없이 연 로컬 운영자(ADR 0016) — 로컬 실행에서 세션 쿠키 없이 localhost로 들어와 첫 운영자 계정으로
   * 풀린 사용자. 세션이 없어 로그아웃·로그인한 기기 목록이 없습니다. 없으면(AWS·이전 백엔드) 계정 세션입니다.
   */
  local?: boolean;
  /**
   * Tailscale 신원으로 로그인 없이 연 운영자(ADR 0023 — Vultr 서버, Tailscale Serve가 붙인 사용자 신원이 운영자로 정한 사용자). local도 true이고,
   * 셸·내 계정은 'Tailscale · 로그인 없음'으로 적습니다.
   */
  tailnet?: boolean;
}

export interface SessionResponse {
  authenticated: boolean;
  /** 가입·비밀번호 재설정을 쓸 수 있는지(백엔드에 메일 발송이 설정됐는지). */
  mailAvailable?: boolean;
  readMode?: string;
  user?: SessionUser;
  /**
   * 로그인 없이 여는 로컬 실행인가(ADR 0016) — 또는 Tailscale 신원으로 연 요청(ADR 0023). true일 때만 로그인 화면으로 보내지 않습니다 —
   * 없거나 false면 지금처럼 로그인(AWS 웹 데모·QA 스택은 false, 이전 백엔드는 보내지 않음).
   */
  noLogin?: boolean;
  /** 로그인 없이 열려는데 운영자 계정이 아직 없음 — noLogin이고 localhost 요청일 때만 true. */
  ownerMissing?: boolean;
}

export interface LoginSession {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
}

/** 사용자 관리 목록의 한 줄. */
export interface AdminUser {
  id: number;
  email: string;
  role: SessionUser["role"];
  tier: SessionUser["tier"];
  verified: boolean;
  createdAt: string;
}

export interface AuditEntry {
  at: string;
  userId: number | null;
  action: string;
  detail: string;
}
