"""gate 시험 — 표준 라이브러리 unittest 만 쓴다.

실행: python3 -I -m unittest discover -s gate -v   (aws-deploy 폴더에서)
"""

from __future__ import annotations

import http.client
import io
import json
import queue
import re
import threading
import time
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode, urlsplit

import gate

SECRET = "s" * 40
CODE_A, CODE_B = "correct-horse-1", "recruiter-xyz-2"


def make_config(**overrides) -> gate.Config:
    cfg = gate.Config(
        secret=SECRET.encode(),
        codes={"alice": gate.hash_code(CODE_A), "acme": gate.hash_code(CODE_B)},
        services={"macro": {"title": "Macro", "note": "데모 계정 안내"}, "wakeline": {"title": "Wakeline"}},
        hours="평일 09–18",
        cookie_ttl=3600,
        cookie_secure=True,
    )
    for key, value in overrides.items():
        setattr(cfg, key, value)
    return cfg


class HashTest(unittest.TestCase):
    def test_hash_roundtrip(self):
        enc = gate.hash_code("abc12345")
        self.assertTrue(gate.check_code("abc12345", enc))
        self.assertFalse(gate.check_code("abc12346", enc))

    def test_bad_hash_is_false(self):
        self.assertFalse(gate.check_code("x", "scrypt.broken"))
        self.assertFalse(gate.check_code("x", "md5.1.2.3.a.b"))

    def test_parse_codes(self):
        enc = gate.hash_code("abc12345")
        self.assertEqual(gate.parse_codes(f" a-1:{enc} , b_2:{enc} "), {"a-1": enc, "b_2": enc})
        with self.assertRaises(ValueError):
            gate.parse_codes("no-colon")
        with self.assertRaises(ValueError):
            gate.parse_codes("bad name:scrypt.x")
        with self.assertRaises(ValueError):
            gate.parse_codes("a:plaintext")

    def test_config_requires_secret_and_codes(self):
        with self.assertRaises(ValueError):
            gate.Config.from_env({"GATE_SECRET": "short", "GATE_CODES": ""})
        with self.assertRaises(ValueError):
            gate.Config.from_env({"GATE_SECRET": SECRET, "GATE_CODES": ""})
        cfg = gate.Config.from_env({"GATE_SECRET": SECRET, "GATE_CODES": f"a:{gate.hash_code('abc12345')}"})
        self.assertIn("macro", cfg.services)  # 기본 services.json
        self.assertTrue(cfg.cookie_secure)
        self.assertEqual(cfg.cookie_name, "__Host-pf_gate")


class TokenTest(unittest.TestCase):
    def test_valid(self):
        tok = gate.sign_token(b"k" * 32, "macro", "alice", 2000)
        self.assertEqual(gate.read_token(b"k" * 32, tok, service="macro", now=1000), "alice")

    def test_expired_wrong_service_tampered_wrong_key(self):
        tok = gate.sign_token(b"k" * 32, "macro", "alice", 2000)
        self.assertIsNone(gate.read_token(b"k" * 32, tok, service="macro", now=2000))
        self.assertIsNone(gate.read_token(b"k" * 32, tok, service="wakeline", now=1000))
        self.assertIsNone(gate.read_token(b"j" * 32, tok, service="macro", now=1000))
        body, mac = tok.split(".")
        forged = gate._b64e(json.dumps({"s": "macro", "n": "alice", "e": 99999}).encode())
        self.assertIsNone(gate.read_token(b"k" * 32, f"{forged}.{mac}", service="macro", now=1000))
        self.assertIsNone(gate.read_token(b"k" * 32, "garbage", service="macro", now=1000))
        self.assertIsNone(gate.read_token(b"k" * 32, "ü.ü", service="macro", now=1000))


class SafeNextTest(unittest.TestCase):
    def test_cases(self):
        ok = ["/", "/a/b?c=1", "/ops#x"]
        for path in ok:
            self.assertEqual(gate.safe_next(path), path)
        bad = [None, "", "https://evil.example", "//evil.example", "/\\evil", "/a\r\nSet-Cookie: x",
               "/__gate/unlock", "x" * 3000, "relative"]
        for path in bad:
            self.assertEqual(gate.safe_next(path), "/", path)


class LimiterTest(unittest.TestCase):
    def test_ip_lock_after_five(self):
        lim = gate.Limiter()
        for i in range(gate.IP_MAX_FAILS):
            self.assertEqual(lim.blocked_for("1.1.1.1", 100 + i), 0)
            lim.record_failure("1.1.1.1", 100 + i)
        self.assertGreater(lim.blocked_for("1.1.1.1", 105), 0)
        self.assertEqual(lim.blocked_for("2.2.2.2", 105), 0)
        self.assertEqual(lim.blocked_for("1.1.1.1", 104 + gate.IP_LOCK_S + 1), 0)

    def test_old_failures_expire(self):
        lim = gate.Limiter()
        for i in range(gate.IP_MAX_FAILS - 1):
            lim.record_failure("1.1.1.1", i)
        lim.record_failure("1.1.1.1", gate.IP_WINDOW_S + 10)
        self.assertEqual(lim.blocked_for("1.1.1.1", gate.IP_WINDOW_S + 10), 0)

    def test_global_lock(self):
        lim = gate.Limiter()
        for i in range(gate.GLOBAL_MAX_FAILS):
            lim.record_failure(f"10.0.0.{i}", 100)
        self.assertGreater(lim.blocked_for("9.9.9.9", 101), 0)

    def test_success_clears_ip_failures(self):
        lim = gate.Limiter()
        for i in range(gate.IP_MAX_FAILS - 1):
            lim.record_failure("1.1.1.1", i)
        lim.record_success("1.1.1.1")
        lim.record_failure("1.1.1.1", 10)
        self.assertEqual(lim.blocked_for("1.1.1.1", 10), 0)

    def test_tracked_ips_bounded(self):
        lim = gate.Limiter()
        old = gate.MAX_TRACKED_IPS
        gate.MAX_TRACKED_IPS = 50
        try:
            for i in range(200):
                lim.record_failure(f"ip{i}", 0)
            self.assertLessEqual(len(lim.fails_by_ip), 50)
        finally:
            gate.MAX_TRACKED_IPS = old


class AttemptSlotTest(unittest.TestCase):
    """확인과 기록이 한 잠금 안에서 — 결과를 기다리는 시도도 한도에 센다(QA-1601)."""

    def test_slots_counted_before_result(self):
        lim = gate.Limiter()
        admitted = [lim.begin_attempt("1.1.1.1", 100) == 0 for _ in range(gate.IP_MAX_FAILS + 3)]
        self.assertEqual(admitted.count(True), gate.IP_MAX_FAILS)
        self.assertEqual(lim.blocked_for("1.1.1.1", 100), 0)  # 아직 잠긴 것은 아니다 — 몫이 찼을 뿐
        self.assertEqual(lim.begin_attempt("2.2.2.2", 100), 0)  # 다른 IP 는 영향 없음
        lim.cancel_attempt("2.2.2.2")
        for _ in range(gate.IP_MAX_FAILS):
            lim.finish_attempt("1.1.1.1", 101, ok=False)
        self.assertGreater(lim.blocked_for("1.1.1.1", 102), 0)
        self.assertEqual((lim.pending_by_ip, lim.pending_total), ({}, 0))

    def test_correct_code_gives_the_slot_back(self):
        lim = gate.Limiter()
        for _ in range(gate.IP_MAX_FAILS - 1):
            self.assertEqual(lim.begin_attempt("1.1.1.1", 100), 0)
            lim.finish_attempt("1.1.1.1", 100, ok=False)
        self.assertEqual(lim.begin_attempt("1.1.1.1", 101), 0)  # 마지막 몫
        self.assertGreater(lim.begin_attempt("1.1.1.1", 101), 0)  # 결과를 기다리는 동안 더는 못 들어온다
        lim.finish_attempt("1.1.1.1", 101, ok=True)  # 맞으면 몫을 돌려주고 실패도 지운다(순서대로일 때와 같다)
        self.assertEqual(lim.blocked_for("1.1.1.1", 101), 0)
        self.assertNotIn("1.1.1.1", lim.fails_by_ip)
        self.assertEqual(lim.begin_attempt("1.1.1.1", 102), 0)
        lim.cancel_attempt("1.1.1.1")

    def test_cancel_is_not_a_failure(self):
        lim = gate.Limiter()
        for _ in range(gate.IP_MAX_FAILS * 3):
            self.assertEqual(lim.begin_attempt("1.1.1.1", 100), 0)
            lim.cancel_attempt("1.1.1.1")
        self.assertEqual(lim.blocked_for("1.1.1.1", 100), 0)
        self.assertNotIn("1.1.1.1", lim.fails_by_ip)
        self.assertEqual(len(lim.global_fails), 0)

    def test_global_slots(self):
        lim = gate.Limiter()
        admitted = sum(lim.begin_attempt(f"10.0.0.{i}", 100) == 0 for i in range(gate.GLOBAL_MAX_FAILS + 10))
        self.assertEqual(admitted, gate.GLOBAL_MAX_FAILS)

    def test_threads_cannot_pass_the_check_together(self):
        lim, n = gate.Limiter(), 40
        barrier, results = threading.Barrier(n), []

        def attempt():
            barrier.wait()
            results.append(lim.begin_attempt("1.1.1.1", 100) == 0)

        threads = [threading.Thread(target=attempt) for _ in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        self.assertEqual((len(results), results.count(True)), (n, gate.IP_MAX_FAILS))


class TextLinesTest(unittest.TestCase):
    def test_sentences_become_lines(self):
        out = gate.text_lines("조회 전용 데모입니다. 투자 권유가 아닙니다.")
        self.assertEqual(out, '<span class="ln">조회 전용 데모입니다.</span><span class="ln">투자 권유가 아닙니다.</span>')
        self.assertEqual(gate.text_lines("운영 시간 09:00–18:00"), '<span class="ln">운영 시간 09:00–18:00</span>')
        self.assertEqual(gate.text_lines(""), "")

    def test_list_lines_and_items_kept_whole(self):
        out = gate.text_lines(["글로벌 매크로 · 순유동성", "COT"])
        self.assertEqual(out, '<span class="ln"><span class="u">글로벌 매크로\xa0·</span> '
                              '<span class="u">순유동성</span></span><span class="ln">COT</span>')

    def test_escaped(self):
        self.assertNotIn("<b>", gate.text_lines("<b>x</b> · y"))


class ServerTest(unittest.TestCase):
    """실제 HTTP 서버를 띄워 Caddy 가 보낼 요청을 흉내 낸다."""

    def setUp(self):
        self.cfg = make_config()
        self.limiter = gate.Limiter()
        self.server = gate.make_server(self.cfg, "127.0.0.1:0", self.limiter)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.log = io.StringIO()
        self._redirect = redirect_stdout(self.log)
        self._redirect.__enter__()

    def tearDown(self):
        self._redirect.__exit__(None, None, None)
        self.server.shutdown()
        self.server.server_close()

    def request(self, method, path, *, service="macro", headers=None, body=None, ip="203.0.113.7"):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        hdrs = {"Host": "dmacro.cloudfront.net", "X-Gate-Client-IP": ip}
        if service is not None:
            hdrs["X-Gate-Service"] = service
        hdrs.update(headers or {})
        conn.request(method, path, body=body, headers=hdrs)
        res = conn.getresponse()
        data = res.read()
        conn.close()
        return res, data

    def unlock(self, code, next_path="/dash?x=1", **kw):
        body = urlencode({"code": code, "next": next_path})
        headers = {"Content-Type": "application/x-www-form-urlencoded", **kw.pop("headers", {})}
        return self.request("POST", "/__gate/unlock", body=body, headers=headers, **kw)

    def cookie_from(self, res):
        set_cookie = res.getheader("Set-Cookie")
        self.assertIsNotNone(set_cookie)
        return set_cookie.split(";", 1)[0]

    def test_healthz(self):
        res, data = self.request("GET", "/__gate/healthz", service=None)
        self.assertEqual((res.status, data), (200, b"ok"))

    def test_unknown_service_rejected(self):
        res, _ = self.request("GET", "/__gate/verify", service="other")
        self.assertEqual(res.status, 403)
        res, _ = self.request("GET", "/__gate/verify", service=None)
        self.assertEqual(res.status, 403)

    def test_locked_navigation_gets_page(self):
        res, data = self.request("GET", "/__gate/verify",
                                 headers={"Accept": "text/html,*/*", "X-Forwarded-Method": "GET",
                                          "X-Forwarded-Uri": "/sector?tab=1"})
        self.assertEqual(res.status, 401)
        self.assertIn("text/html", res.getheader("Content-Type"))
        self.assertIn("default-src 'none'", res.getheader("Content-Security-Policy"))
        self.assertEqual(res.getheader("Cache-Control"), "no-store")
        page = data.decode()
        self.assertIn("Macro", page)
        self.assertIn('value="/sector?tab=1"', page)
        self.assertIn("데모 계정 안내", page)

    def test_locked_api_gets_json(self):
        for headers in ({"Accept": "application/json", "X-Forwarded-Method": "GET"},
                        {"Accept": "text/html", "X-Forwarded-Method": "POST"},
                        {"Accept": "text/html", "X-Forwarded-Method": "GET", "Upgrade": "websocket"}):
            res, data = self.request("GET", "/__gate/verify", headers=headers)
            self.assertEqual(res.status, 401, headers)
            self.assertEqual(json.loads(data)["error"], "locked")

    def test_unlock_flow(self):
        res, _ = self.unlock(CODE_A)
        self.assertEqual(res.status, 303)
        self.assertEqual(res.getheader("Location"), "/dash?x=1")
        set_cookie = res.getheader("Set-Cookie")
        for attr in ("__Host-pf_gate=", "HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=3600"):
            self.assertIn(attr, set_cookie)
        cookie = self.cookie_from(res)
        res, _ = self.request("GET", "/__gate/verify", headers={"Cookie": f"other=1; {cookie}"})
        self.assertEqual(res.status, 200)
        # 다른 서비스에는 통하지 않는다
        res, _ = self.request("GET", "/__gate/verify", service="wakeline", headers={"Cookie": cookie})
        self.assertEqual(res.status, 401)
        self.assertIn('"code": "alice"', self.log.getvalue())
        self.assertNotIn(CODE_A, self.log.getvalue())

    def test_second_code_and_revocation(self):
        res, _ = self.unlock(CODE_B)
        cookie = self.cookie_from(res)
        del self.cfg.codes["acme"]  # 코드를 지우면 이미 준 쿠키도 무효
        res, _ = self.request("GET", "/__gate/verify", headers={"Cookie": cookie})
        self.assertEqual(res.status, 401)

    def test_wrong_code(self):
        res, data = self.unlock("nope-nope")
        self.assertEqual(res.status, 401)
        self.assertIsNone(res.getheader("Set-Cookie"))
        self.assertIn("올바르지 않습니다", data.decode())

    def test_lockout_after_failures_then_correct_code_refused(self):
        for _ in range(gate.IP_MAX_FAILS):
            self.unlock("wrong-code")
        res, data = self.unlock(CODE_A)
        self.assertEqual(res.status, 429)
        self.assertIsNotNone(res.getheader("Retry-After"))
        self.assertIsNone(res.getheader("Set-Cookie"))
        # 다른 IP 는 영향 없음
        res, _ = self.unlock(CODE_A, ip="198.51.100.9")
        self.assertEqual(res.status, 303)

    def test_open_redirect_blocked(self):
        res, _ = self.unlock(CODE_A, next_path="//evil.example/")
        self.assertEqual(res.getheader("Location"), "/")

    def test_cross_origin_unlock_refused(self):
        res, _ = self.unlock(CODE_A, headers={"Origin": "https://evil.example"})
        self.assertEqual(res.status, 403)
        res, _ = self.unlock(CODE_A, headers={"Origin": "https://dmacro.cloudfront.net"})
        self.assertEqual(res.status, 303)

    def test_null_origin_needs_same_origin_fetch_site(self):
        # 폼 POST 는 엄격한 Referrer-Policy 아래에서 Origin: null 로 온다 — 브라우저가 붙이는 Sec-Fetch-Site 로 가린다
        res, _ = self.unlock(CODE_A, headers={"Origin": "null", "Sec-Fetch-Site": "same-origin"})
        self.assertEqual(res.status, 303)
        for site in ("cross-site", "same-site", None):
            headers = {"Origin": "null"} if site is None else {"Origin": "null", "Sec-Fetch-Site": site}
            res, data = self.unlock(CODE_A, headers=headers)
            self.assertEqual(res.status, 403, site)
            self.assertEqual(json.loads(data)["error"], "cross-origin")

    def test_referrer_policy_keeps_form_origin(self):
        # no-referrer 면 브라우저가 같은 출처 폼 POST 에도 Origin: null 을 보낸다
        res, _ = self.request("GET", "/__gate/")
        self.assertEqual(res.getheader("Referrer-Policy"), "same-origin")

    def test_oversized_body(self):
        res, _ = self.request("POST", "/__gate/unlock", body="code=" + "a" * 5000,
                              headers={"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(res.status, 413)

    def test_lock_clears_cookie(self):
        res, _ = self.request("GET", "/__gate/lock")
        self.assertEqual(res.status, 303)
        self.assertIn("Max-Age=0", res.getheader("Set-Cookie"))

    def test_lock_page_redirects_when_unlocked(self):
        res, _ = self.unlock(CODE_A)
        res, _ = self.request("GET", "/__gate/", headers={"Cookie": self.cookie_from(res)})
        self.assertEqual(res.status, 303)
        res, data = self.request("GET", "/__gate/?next=/radar")
        self.assertEqual(res.status, 200)
        self.assertIn('value="/radar"', data.decode())

    def test_html_escaping(self):
        res, data = self.request("GET", "/__gate/verify",
                                 headers={"Accept": "text/html", "X-Forwarded-Uri": '/"><script>alert(1)</script>'})
        self.assertNotIn("<script>alert", data.decode())

    def test_insecure_cookie_mode(self):
        self.cfg.cookie_secure = False
        res, _ = self.unlock(CODE_A)
        set_cookie = res.getheader("Set-Cookie")
        self.assertTrue(set_cookie.startswith("pf_gate="))
        self.assertNotIn("Secure", set_cookie)


class ConcurrentUnlockTest(unittest.TestCase):
    """동시에 들어온 잠금 해제 요청(QA-1601 · QA-1602). 코드 검사를 release 까지 멈춰 세워 경쟁을 결정적으로 만든다 —
    시간에 기대지 않고, 검사 안에 들어간 수와 먼저 돌아온 응답으로 판정한다."""

    WAIT_S = 10

    def start(self, max_checks: int) -> None:
        self.cfg = make_config(codes={"alice": gate.hash_code(CODE_A)})  # 코드 하나 — 요청 하나에 검사 한 번
        self.limiter = gate.Limiter()
        self.server = gate.make_server(self.cfg, "127.0.0.1:0", self.limiter, max_checks=max_checks)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.release = threading.Event()
        self.cond = threading.Condition()
        self.inside = self.entered = self.peak = 0
        real_check = gate.check_code

        def held_check(code, encoded):
            with self.cond:
                self.inside += 1
                self.entered += 1
                self.peak = max(self.peak, self.inside)
                self.cond.notify_all()
            self.release.wait(self.WAIT_S)
            with self.cond:
                self.inside -= 1
            return real_check(code, encoded)

        patcher = mock.patch.object(gate, "check_code", held_check)
        patcher.start()
        self.log = io.StringIO()
        redirect = redirect_stdout(self.log)
        redirect.__enter__()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.addCleanup(redirect.__exit__, None, None, None)
        self.addCleanup(patcher.stop)
        self.addCleanup(self.release.set)  # 실패해도 멈춘 요청을 풀어 준다(정리 순서: 이것이 먼저)

    def unlock(self, code, ip):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=self.WAIT_S)
        conn.request("POST", "/__gate/unlock", body=urlencode({"code": code, "next": "/"}),
                     headers={"Host": "dmacro.cloudfront.net", "X-Gate-Service": "macro", "X-Gate-Client-IP": ip,
                              "Content-Type": "application/x-www-form-urlencoded"})
        res = conn.getresponse()
        data = res.read()
        conn.close()
        return res, data

    def burst(self, ips):
        """같은 순간에 틀린 코드를 보낸다 — 응답 상태가 오는 대로 담기는 큐를 돌려준다."""
        out, barrier = queue.Queue(), threading.Barrier(len(ips))

        def one(ip):
            barrier.wait()
            try:
                out.put(self.unlock("wrong-code-000", ip)[0].status)
            except OSError as e:
                out.put(type(e).__name__)

        for ip in ips:
            threading.Thread(target=one, args=(ip,), daemon=True).start()
        return out

    def take(self, out, n):
        return [out.get(timeout=self.WAIT_S) for _ in range(n)]

    def wait_entered(self, n):
        with self.cond:
            self.assertTrue(self.cond.wait_for(lambda: self.entered >= n, self.WAIT_S), f"검사에 들어간 수 {self.entered} < {n}")

    def test_same_ip_burst_checks_at_most_the_ip_limit(self):
        self.start(max_checks=100)  # 동시 검사 상한은 따로 시험 — 여기서는 시도 제한만
        n = gate.IP_MAX_FAILS + 7
        out = self.burst(["203.0.113.7"] * n)
        early = self.take(out, n - gate.IP_MAX_FAILS)  # 검사 중인 요청은 멈춰 있으니 먼저 오는 것은 거절된 요청뿐
        self.assertEqual(early, [429] * (n - gate.IP_MAX_FAILS))
        self.assertEqual(self.entered, gate.IP_MAX_FAILS)
        self.release.set()
        self.assertEqual(self.take(out, gate.IP_MAX_FAILS), [401] * gate.IP_MAX_FAILS)
        res, _ = self.unlock(CODE_A, "203.0.113.7")  # 그 IP 는 잠겼다 — 맞는 코드도 429
        self.assertEqual(res.status, 429)
        self.assertEqual(self.entered, gate.IP_MAX_FAILS)

    def test_many_ips_burst_checks_at_most_the_global_limit(self):
        self.start(max_checks=100)
        with mock.patch.object(gate, "GLOBAL_MAX_FAILS", 6):  # 요청 수를 줄이려고 전체 한도만 작게
            n = 6 + 4
            out = self.burst([f"198.51.100.{i}" for i in range(n)])
            self.assertEqual(self.take(out, 4), [429] * 4)
            self.assertEqual(self.entered, 6)
            self.release.set()
            self.assertEqual(self.take(out, 6), [401] * 6)
            res, _ = self.unlock(CODE_A, "192.0.2.1")  # 전체가 잠겼다 — 처음 보는 IP 도 429
            self.assertEqual(res.status, 429)

    def test_busy_checks_refused_at_once_without_counting(self):
        self.start(max_checks=gate.MAX_CONCURRENT_CHECKS)
        out = self.burst([f"198.51.100.{i}" for i in range(gate.MAX_CONCURRENT_CHECKS)])
        self.wait_entered(gate.MAX_CONCURRENT_CHECKS)  # 자리가 모두 찼다(멈춰 있음)
        res, data = self.unlock(CODE_A, "192.0.2.50")  # 기다리게 하면 여기서 시간 초과로 실패한다
        self.assertEqual(res.status, 429)
        self.assertEqual(res.getheader("Retry-After"), str(gate.BUSY_RETRY_S))
        self.assertIsNone(res.getheader("Set-Cookie"))
        self.assertIn("text/html", res.getheader("Content-Type"))
        self.assertIn("요청이 많습니다", data.decode())
        self.assertIn('"event": "unlock_busy"', self.log.getvalue())
        self.assertNotIn("192.0.2.50", self.limiter.fails_by_ip)  # 코드를 보지 않았으니 실패가 아니다
        self.assertEqual(len(self.limiter.global_fails), 0)
        self.assertEqual(self.entered, gate.MAX_CONCURRENT_CHECKS)
        self.release.set()
        self.assertEqual(self.take(out, gate.MAX_CONCURRENT_CHECKS), [401] * gate.MAX_CONCURRENT_CHECKS)
        res, _ = self.unlock(CODE_A, "192.0.2.50")  # 자리가 나면 평소처럼 풀린다
        self.assertEqual(res.status, 303)
        self.assertTrue(res.getheader("Set-Cookie").startswith("__Host-pf_gate="))
        self.assertLessEqual(self.peak, gate.MAX_CONCURRENT_CHECKS)
        self.assertEqual((self.limiter.pending_by_ip, self.limiter.pending_total), ({}, 0))

    def test_check_error_counts_as_failure_and_frees_the_slot(self):
        self.start(max_checks=1)
        self.release.set()
        with mock.patch.object(gate, "check_code", side_effect=RuntimeError("boom")), redirect_stderr(io.StringIO()):
            with self.assertRaises(http.client.HTTPException):  # 처리기가 예외로 끝나 응답 없이 끊긴다
                self.unlock(CODE_A, "192.0.2.9")
        self.assertEqual(len(self.limiter.fails_by_ip["192.0.2.9"]), 1)
        self.assertEqual((self.limiter.pending_by_ip, self.limiter.pending_total), ({}, 0))
        res, _ = self.unlock(CODE_A, "192.0.2.10")  # 자리(1)가 돌아왔다
        self.assertEqual(res.status, 303)

    def test_concurrent_checks_fit_the_container_memory(self):
        compose = (Path(gate.__file__).resolve().parent.parent / "compose.yml").read_text(encoding="utf-8")
        gate_block = compose.split("\n  gate:", 1)[1].split("\n  caddy:", 1)[0]
        mem_limit = int(re.search(r"mem_limit:\s*(\d+)m", gate_block).group(1)) * 2**20
        scrypt_bytes = 128 * gate.SCRYPT_R * gate.SCRYPT_N  # 검사 한 번에 쓰는 scrypt 메모리(16 MiB)
        # 나머지 절반은 파이썬 · 스레드 · 여유. 실측(96m 컨테이너, memory.peak): 동시 2개 49 MiB · 4개 82 MiB · 5개부터 OOM(137)
        self.assertLessEqual(gate.MAX_CONCURRENT_CHECKS * scrypt_bytes, mem_limit // 2)
        self.assertGreaterEqual(gate.MAX_CONCURRENT_CHECKS, 1)


# ── 텔레그램 알림 ─────────────────────────────────────────────
# 실제 텔레그램은 부르지 않는다 — 전송부(transport)와 시계를 가짜로 바꿔 끼우거나 urllib 의 urlopen 을 가짜로.

TOKEN, CHAT_ID = "123456789:AAH-fake-token-for-tests_xyz", "987654321"
T0 = datetime(2026, 10, 15, 1, 32, tzinfo=timezone.utc).timestamp()  # 2026-10-15 10:32 KST
SERVICES = {"macro": {"title": "Macro"}, "wakeline": {"title": "Wakeline"}}
CHROME_WIN = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/129.0.0.0 Safari/537.36")


class Capture:
    """표준 출력(log_event)을 잡는다 — 작업자 스레드가 찍는 것까지."""

    def capture(self) -> io.StringIO:
        self.log = io.StringIO()
        redirect = redirect_stdout(self.log)
        redirect.__enter__()
        self.addCleanup(redirect.__exit__, None, None, None)
        return self.log


class MaskIpTest(unittest.TestCase):
    def test_cases(self):
        cases = {
            "211.234.12.34": "211.234.12.x",
            " 10.0.0.1 ": "10.0.0.x",
            "2001:db8:1:2::5": "2001:db8:1::/48",
            "2001:db8:abcd:ffff:1:2:3:4": "2001:db8:abcd::/48",
            "fe80::1%eth0": "fe80::/48",
            "::ffff:1.2.3.4": "1.2.3.x",  # IPv4-mapped IPv6 는 IPv4 로
            "2002:d3ea:c22::1": "211.234.12.x",  # 6to4 — /48 에 IPv4(211.234.12.34)가 통째로 들어 있어 IPv4 로 가린다
            "2001:0:4136:e378:8000:63bf:3fff:fdd2": "2001:0:4136::/48",  # Teredo — 클라이언트 IPv4 는 /48 밖(하위 32비트)
            "": "알 수 없음",
            None: "알 수 없음",
            "garbage": "알 수 없음",
            "1.2.3": "알 수 없음",
            "999.1.1.1": "알 수 없음",
            "example.com": "알 수 없음",  # 이름은 해석하지 않는다(DNS 조회 없음)
        }
        for raw, want in cases.items():
            self.assertEqual(gate.mask_ip(raw), want, raw)


class DescribeDeviceTest(unittest.TestCase):
    CASES = [
        (CHROME_WIN, "Chrome · Windows"),
        (CHROME_WIN + " Edg/129.0.0.0", "Edge · Windows"),
        ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 "
         "Whale/3.27.254.15 Safari/537.36", "Whale · Windows"),
        ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
         "Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0", "Opera · macOS"),
        ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) "
         "Version/18.0 Safari/605.1.15", "Safari · macOS"),
        ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
         "Version/18.0 Mobile/15E148 Safari/604.1", "Safari · iOS"),
        ("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
         "CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1", "Chrome · iPadOS"),
        ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
         "FxiOS/131.0 Mobile/15E148 Safari/605.1.15", "Firefox · iOS"),
        ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
         "Version/17.0 EdgiOS/129.0.2792.84 Mobile/15E148 Safari/605.1.15", "Edge · iOS"),
        ("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 "
         "Mobile Safari/537.36 EdgA/129.0.0.0", "Edge · Android"),
        ("Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) "
         "SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36", "Samsung Internet · Android"),
        ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
         "Mobile/15E148 KAKAOTALK 10.8.0", "카카오톡 · iOS"),
        ("Mozilla/5.0 (Linux; Android 13; SM-G991N; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 "
         "Chrome/120.0.6099.230 Mobile Safari/537.36;KAKAOTALK 2410800", "카카오톡 · Android"),
        ("Mozilla/5.0 (Linux; Android 14; SM-S911N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) "
         "Version/4.0 Chrome/125.0.6422.165 Mobile Safari/537.36 NAVER(inapp; search; 2000; 12.6.6)", "네이버 앱 · Android"),
        ("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox · Linux"),
        ("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 "
         "Safari/537.36", "Chrome · ChromeOS"),
        ("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "알 수 없음 · Windows"),
        ("curl/8.7.1", "알 수 없음"),
        ("", "알 수 없음"),
        (None, "알 수 없음"),
    ]

    def test_cases(self):
        for ua, want in self.CASES:
            self.assertEqual(gate.describe_device(ua), want, ua)

    def test_long_header_is_cut(self):
        # 정규식이 긴 헤더에 오래 걸리지 않게 앞부분만 본다 — 끝에 붙은 이름은 보지 않는다
        self.assertEqual(gate.describe_device("Version/1 " * 20_000 + "Safari/1"), "알 수 없음")
        self.assertEqual(gate.describe_device(CHROME_WIN + " x" * 50_000), "Chrome · Windows")


class NewLocksTest(unittest.TestCase):
    """finish_attempt 는 이번 실패로 잠금이 '새로' 걸렸는지 알려 준다(잠금 동작은 그대로)."""

    def test_ip_lock_reported_on_the_locking_attempt_only(self):
        lim = gate.Limiter()
        got = []
        for i in range(gate.IP_MAX_FAILS):
            self.assertEqual(lim.begin_attempt("1.1.1.1", 100 + i), 0)
            got.append(lim.finish_attempt("1.1.1.1", 100 + i, ok=False))
        self.assertEqual(got[:-1], [gate.NewLocks()] * (gate.IP_MAX_FAILS - 1))
        self.assertEqual(got[-1], gate.NewLocks(ip_locked=True))
        self.assertGreater(lim.begin_attempt("1.1.1.1", 105), 0)  # 잠긴 동안은 몫을 못 잡아 finish 까지 오지 않는다

    def test_success_reports_nothing(self):
        lim = gate.Limiter()
        self.assertEqual(lim.begin_attempt("1.1.1.1", 100), 0)
        self.assertEqual(lim.finish_attempt("1.1.1.1", 100, ok=True), gate.NewLocks())

    def test_global_lock_reported_once(self):
        lim = gate.Limiter()
        got = [lim.record_failure(f"10.0.0.{i}", 100) for i in range(gate.GLOBAL_MAX_FAILS)]
        self.assertEqual(got[-1], gate.NewLocks(global_locked=True))
        self.assertEqual(sum(r.global_locked or r.ip_locked for r in got), 1)


class NotifierTest(Capture, unittest.TestCase):
    """메시지 내용 · 중복 억제 · 큐 — 가짜 전송부와 가짜 시계."""

    def make(self, transport=None, **kw) -> gate.Notifier:
        self.now = T0
        self.sent = []
        return gate.Notifier(SERVICES, transport or self.sent.append, clock=lambda: self.now, **kw)

    def test_unlock_message(self):
        n = self.make()
        n.unlocked("macro", "211.234.12.34", "recruit", CHROME_WIN)
        self.assertTrue(n.flush(5))
        self.assertEqual(self.sent, ["🔓 Macro — 잠금 해제\n코드: recruit\n시각: 2026-10-15 10:32 KST\n"
                                     "IP: 211.234.12.x\n기기: Chrome · Windows"])

    def test_lock_messages_use_the_limits(self):
        n = self.make()
        n.locked_ip("macro", "2001:db8:1:2::5", None)
        n.locked_global("wakeline")
        self.assertTrue(n.flush(5))
        self.assertEqual(self.sent, [
            "⛔ Macro — 접근 코드 5회 실패\n15분 안에 5회 틀려 이 IP 를 15분 동안 막습니다\n"
            "시각: 2026-10-15 10:32 KST\nIP: 2001:db8:1::/48\n기기: 알 수 없음",
            "🚨 Wakeline — 전체 잠금\n1시간 안에 30회 틀려 30분 동안 모든 서비스의 시도를 막습니다\n시각: 2026-10-15 10:32 KST",
        ])
        # 숫자는 상수에서 온다
        with mock.patch.multiple(gate, IP_MAX_FAILS=3, IP_LOCK_S=3600, GLOBAL_MAX_FAILS=6, GLOBAL_LOCK_S=7200):
            n.locked_ip("macro", "1.2.3.4", None)
            n.locked_global("macro")
            self.assertTrue(n.flush(5))
        self.assertIn("3회 틀려 이 IP 를 1시간 동안", self.sent[2])
        self.assertIn("6회 틀려 2시간 동안", self.sent[3])

    def test_unknown_service_uses_its_key(self):
        n = self.make()
        n.unlocked("other", "1.2.3.4", "recruit", None)
        self.assertTrue(n.flush(5))
        self.assertTrue(self.sent[0].startswith("🔓 other — 잠금 해제\n"))

    def test_same_service_and_ip_once_an_hour(self):
        n = self.make()
        n.unlocked("macro", "1.2.3.4", "recruit", None)
        self.now = T0 + gate.NOTIFY_REPEAT_S - 1
        n.unlocked("macro", "1.2.3.4", "acme", None)  # 1시간 안 — 조용
        n.unlocked("macro", "1.2.3.5", "recruit", None)  # 같은 /24 라도 전체 IP 가 다르면 따로
        n.unlocked("wakeline", "1.2.3.4", "recruit", None)  # 다른 서비스
        self.assertTrue(n.flush(5))
        self.assertEqual(len(self.sent), 3)
        self.now = T0 + gate.NOTIFY_REPEAT_S
        n.unlocked("macro", "1.2.3.4", "recruit", None)  # 1시간 뒤
        self.assertTrue(n.flush(5))
        self.assertEqual(len(self.sent), 4)

    def test_remembered_pairs_are_bounded(self):
        n = self.make()
        with mock.patch.object(gate, "NOTIFY_SEEN_MAX", 3):
            for i, ip in enumerate(["ip1", "ip2", "ip3"]):
                self.now = T0 + i
                n.unlocked("macro", ip, "recruit", None)
            self.now = T0 + gate.NOTIFY_REPEAT_S + 0.5  # ip1 만 지났다
            n.unlocked("macro", "ip4", "recruit", None)
            self.assertEqual(list(n._seen), [("macro", "ip2"), ("macro", "ip3"), ("macro", "ip4")])
            n.unlocked("macro", "ip5", "recruit", None)  # 지난 것이 없으면 오래된 것부터
            self.assertEqual(list(n._seen), [("macro", "ip3"), ("macro", "ip4"), ("macro", "ip5")])
            n.unlocked("macro", "ip3", "recruit", None)  # 남아 있는 것은 여전히 조용
        self.assertTrue(n.flush(5))
        self.assertEqual(len(self.sent), 5)

    def test_off_without_transport(self):
        n = gate.Notifier(SERVICES, None)
        self.assertFalse(n.enabled)
        n.unlocked("macro", "1.2.3.4", "recruit", CHROME_WIN)
        n.locked_ip("macro", "1.2.3.4", CHROME_WIN)
        n.locked_global("macro")
        self.assertTrue(n.flush(0))
        self.assertEqual(n._seen, {})

    def test_full_queue_drops_without_waiting(self):
        log = self.capture()
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def held(text):
            entered.set()
            release.wait(30)
            self.sent.append(text)

        n = self.make(held, queue_size=1)
        n.unlocked("macro", "ip1", "recruit", None)
        self.assertTrue(entered.wait(5))  # 작업자가 첫 건을 들고 멈춰 있다
        n.unlocked("macro", "ip2", "recruit", None)  # 큐(1)에 들어감
        start = time.monotonic()
        n.unlocked("macro", "ip3", "recruit", None)  # 큐가 찼다 — 기다리지 않고 버린다
        self.assertLess(time.monotonic() - start, 1)
        self.assertIn('"event": "telegram_dropped"', log.getvalue())
        release.set()
        self.assertTrue(n.flush(5))
        self.assertEqual([m.split("\n")[3] for m in self.sent], ["IP: 알 수 없음"] * 2)
        self.assertEqual(len(self.sent), 2)
        n.unlocked("macro", "ip3", "recruit", None)  # 버린 것은 기억하지 않았다 — 다음 해제 때 알린다
        self.assertTrue(n.flush(5))
        self.assertEqual(len(self.sent), 3)
        self.assertTrue(self.sent[2].endswith("\n그 사이 알리지 못한 잠금 해제 1건 (10분에 10건까지만 알립니다)"))

    def test_unlock_alerts_capped_overall(self):
        # 코드를 가진 사람이 IP 를 바꿔 가며(같은 /64) 해제해도 알림은 상한까지만 — 넘친 수는 다음 알림에 덧붙인다
        log = self.capture()
        n = self.make()
        extra = 5
        for i in range(gate.NOTIFY_UNLOCK_MAX + extra):
            n.unlocked("macro", f"2001:db8:1:2::{i:x}", "recruit", None)
        self.assertTrue(n.flush(5))
        self.assertEqual(len(self.sent), gate.NOTIFY_UNLOCK_MAX)
        self.assertEqual(log.getvalue().count('"event": "telegram_capped", "kind": "unlock"'), extra)
        self.assertEqual(len(n._seen), gate.NOTIFY_UNLOCK_MAX)  # 넘친 것은 기억하지 않는다
        n.locked_ip("macro", "9.9.9.9", None)  # 잠금 알림은 상한과 상관없다(Limiter 가 이미 묶는다)
        n.locked_global("macro")
        self.now = T0 + gate.NOTIFY_UNLOCK_WINDOW_S - 1
        n.unlocked("wakeline", "1.2.3.4", "recruit", None)  # 아직 창 안 — 다른 서비스 · IP 라도 넘친 것
        self.assertTrue(n.flush(5))
        self.assertEqual(len(self.sent), gate.NOTIFY_UNLOCK_MAX + 2)
        self.now = T0 + gate.NOTIFY_UNLOCK_WINDOW_S
        n.unlocked("macro", f"2001:db8:1:2::{gate.NOTIFY_UNLOCK_MAX:x}", "recruit", None)  # 넘쳤던 IP — 이제 알린다
        n.unlocked("macro", "1.2.3.5", "recruit", None)
        self.assertTrue(n.flush(5))
        first, second = self.sent[-2:]
        self.assertEqual(first.split("\n")[-1],
                         f"그 사이 알리지 못한 잠금 해제 {extra + 1}건 (10분에 {gate.NOTIFY_UNLOCK_MAX}건까지만 알립니다)")
        self.assertIn("IP: 2001:db8:1::/48", first)
        self.assertTrue(second.endswith("기기: 알 수 없음"))  # 덧붙인 수는 한 번만
        with mock.patch.multiple(gate, NOTIFY_UNLOCK_WINDOW_S=3600, NOTIFY_UNLOCK_MAX=99):  # 숫자는 상수에서 온다
            n._unsaid = 1
            n.unlocked("macro", "1.2.3.6", "recruit", None)
            self.assertTrue(n.flush(5))
        self.assertTrue(self.sent[-1].endswith("(1시간에 99건까지만 알립니다)"))

    def test_send_errors_are_logged_by_name_only_and_not_retried(self):
        log = self.capture()
        calls = []

        def failing(text):
            calls.append(text)
            if len(calls) == 1:
                raise urllib.error.HTTPError(f"https://api.telegram.org/bot{TOKEN}/sendMessage", 429,
                                             "Too Many Requests", {}, io.BytesIO(b"{}"))
            raise RuntimeError(f"cannot reach https://api.telegram.org/bot{TOKEN}/sendMessage chat {CHAT_ID}")

        n = self.make(failing)
        n.unlocked("macro", "1.2.3.4", "recruit", None)
        n.locked_global("macro")
        self.assertTrue(n.flush(5))
        self.assertEqual(len(calls), 2)  # 다시 보내지 않는다(429 포함)
        out = log.getvalue()
        self.assertIn('"event": "telegram_failed", "kind": "unlock", "status": 429', out)
        self.assertIn('"event": "telegram_failed", "kind": "locked_global", "error": "RuntimeError"', out)
        self.assertNotIn(TOKEN, out)
        self.assertNotIn(CHAT_ID, out)
        n.unlocked("macro", "1.2.3.5", "recruit", None)  # 작업자는 살아 있다
        self.assertTrue(n.flush(5))
        self.assertEqual(len(calls), 3)

    def test_never_raises(self):
        log = self.capture()

        def broken_clock():
            raise RuntimeError("clock")

        n = gate.Notifier(SERVICES, lambda text: None, clock=broken_clock)
        n.unlocked("macro", "1.2.3.4", "recruit", None)
        n.locked_ip("macro", "1.2.3.4", None)
        n.locked_global("macro")
        self.assertEqual(log.getvalue().count('"event": "telegram_error"'), 3)


class TelegramTransportTest(Capture, unittest.TestCase):
    """실제 Telegram 요청의 모양 — urllib 의 urlopen 을 가짜로 바꿔 확인한다."""

    def test_request_shape(self):
        transport = gate.TelegramTransport(TOKEN, CHAT_ID)
        with mock.patch.object(gate.urllib.request, "urlopen") as urlopen:
            transport("🔓 Macro — 잠금 해제\n코드: recruit")
        urlopen.assert_called_once()
        req, timeout = urlopen.call_args.args[0], urlopen.call_args.kwargs["timeout"]
        url = urlsplit(req.full_url)
        self.assertEqual((url.scheme, url.netloc, url.path), ("https", "api.telegram.org", f"/bot{TOKEN}/sendMessage"))
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(req.get_header("Content-type"), "application/json; charset=utf-8")
        self.assertEqual(json.loads(req.data), {"chat_id": CHAT_ID, "text": "🔓 Macro — 잠금 해제\n코드: recruit",
                                                "link_preview_options": {"is_disabled": True}})  # 평문 — parse_mode 없음
        self.assertEqual(timeout, gate.TELEGRAM_TIMEOUT_S)
        self.assertLessEqual(gate.TELEGRAM_TIMEOUT_S, 5)
        self.assertNotIn(TOKEN, repr(transport))

    def test_config_wires_the_real_transport_and_logs_no_secret(self):
        log = self.capture()
        cfg = make_config(telegram_token=TOKEN, telegram_chat_id=CHAT_ID)
        n = gate.Notifier.from_config(cfg)
        self.assertIsInstance(n.transport, gate.TelegramTransport)
        url = f"https://api.telegram.org/bot{TOKEN}/sendMessage"
        errors = [urllib.error.HTTPError(url, 429, "Too Many Requests", {}, io.BytesIO(b"{}")),
                  urllib.error.URLError(f"<urlopen error {url}>"), TimeoutError(f"timed out {url}"), mock.MagicMock()]
        with mock.patch.object(gate.urllib.request, "urlopen", side_effect=errors) as urlopen:
            n.locked_ip("macro", "1.2.3.4", None)
            n.locked_global("macro")
            n.unlocked("macro", "1.2.3.4", "alice", None)
            n.unlocked("wakeline", "1.2.3.4", "alice", None)
            self.assertTrue(n.flush(5))
        self.assertEqual(urlopen.call_count, 4)
        self.assertTrue(json.loads(urlopen.call_args.args[0].data)["text"].startswith("🔓 Wakeline — 잠금 해제\n"))
        out = log.getvalue()
        for want in ('"status": 429', '"error": "URLError"', '"error": "TimeoutError"'):
            self.assertIn(want, out)
        self.assertEqual(out.count('"event": "telegram_failed"'), 3)
        self.assertNotIn(TOKEN, out)
        self.assertNotIn(CHAT_ID, out)


class TelegramConfigTest(Capture, unittest.TestCase):
    ENV = {"GATE_SECRET": SECRET}

    @classmethod
    def setUpClass(cls):
        cls.ENV = {**cls.ENV, "GATE_CODES": f"a:{gate.hash_code('abc12345')}"}

    def test_both_set_turns_on_trimmed_and_hidden_from_repr(self):
        log = self.capture()
        cfg = gate.Config.from_env({**self.ENV, "TELEGRAM_BOT_TOKEN": f"  {TOKEN}\n", "TELEGRAM_CHAT_ID": f" {CHAT_ID} "})
        self.assertTrue(cfg.telegram_on)
        self.assertEqual((cfg.telegram_token, cfg.telegram_chat_id), (TOKEN, CHAT_ID))
        self.assertNotIn(TOKEN, repr(cfg))
        self.assertNotIn(CHAT_ID, repr(cfg))
        self.assertEqual(log.getvalue(), "")

    def test_secret_and_code_hashes_hidden_from_repr(self):
        cfg = gate.Config.from_env(dict(self.ENV))
        text = repr(cfg)
        self.assertNotIn(SECRET, text)
        self.assertNotIn(repr(SECRET.encode()), text)
        for name, encoded in cfg.codes.items():
            self.assertNotIn(encoded, text, name)
        self.assertIn("hours=", text)  # 비밀이 아닌 값은 그대로

    def test_only_one_turns_off_with_a_warning_naming_the_missing_one(self):
        for given, missing in (({"TELEGRAM_BOT_TOKEN": TOKEN, "TELEGRAM_CHAT_ID": "  "}, "TELEGRAM_CHAT_ID"),
                               ({"TELEGRAM_CHAT_ID": CHAT_ID}, "TELEGRAM_BOT_TOKEN")):
            log = self.capture()
            cfg = gate.Config.from_env({**self.ENV, **given})
            self.assertFalse(cfg.telegram_on, missing)
            self.assertEqual((cfg.telegram_token, cfg.telegram_chat_id), ("", ""))
            self.assertFalse(gate.Notifier.from_config(cfg).enabled)
            record = json.loads(log.getvalue())
            self.assertEqual((record["event"], record["missing"]), ("telegram_off", missing))
            self.assertNotIn(TOKEN, log.getvalue())
            self.assertNotIn(CHAT_ID, log.getvalue())

    def test_none_set_is_off_and_quiet(self):
        log = self.capture()
        cfg = gate.Config.from_env(dict(self.ENV))
        self.assertFalse(cfg.telegram_on)
        self.assertEqual(log.getvalue(), "")
        server = gate.make_server(make_config(), "127.0.0.1:0")  # 주입하지 않으면 설정대로 — 꺼짐
        self.addCleanup(server.server_close)
        self.assertFalse(server.RequestHandlerClass.notifier.enabled)


class NotifyServerTest(Capture, unittest.TestCase):
    """실제 요청 흐름 — 잠금 해제 · IP 잠금 · 전체 잠금이 알림이 되고, 전송이 느리거나 실패해도 응답은 그대로다."""

    request = ServerTest.request
    unlock = ServerTest.unlock
    WAIT_S = 30

    def start(self, transport=None, *, cfg=None, notifier=True, **kw):
        self.cfg = cfg or make_config()
        self.now = T0
        self.sent = []
        self.notifier = gate.Notifier(self.cfg.services, transport or self.sent.append,
                                      clock=lambda: self.now, **kw) if notifier else None
        self.server = gate.make_server(self.cfg, "127.0.0.1:0", gate.Limiter(), notifier=self.notifier)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        return self.capture()

    def flush(self):
        self.assertTrue(self.server.RequestHandlerClass.notifier.flush(5))

    def test_unlock_sends_one_masked_message(self):
        self.start()
        res, _ = self.unlock(CODE_A, ip="211.234.12.34", headers={"User-Agent": CHROME_WIN})
        self.assertEqual(res.status, 303)
        self.flush()
        self.assertEqual(len(self.sent), 1)
        msg = self.sent[0]
        for want in ("🔓 Macro — 잠금 해제", "코드: alice", "시각: 2026-10-15 10:32 KST", "IP: 211.234.12.x",
                     "기기: Chrome · Windows"):
            self.assertIn(want, msg)
        for secret in ("211.234.12.34", "Mozilla", CODE_A):  # 전체 IP · UA 원문 · 코드 자체는 보내지 않는다
            self.assertNotIn(secret, msg)

    def test_repeat_unlock_is_quiet_for_an_hour(self):
        self.start()
        for _ in range(2):
            self.assertEqual(self.unlock(CODE_A)[0].status, 303)
        self.flush()
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.unlock(CODE_A, service="wakeline")[0].status, 303)  # 다른 서비스는 따로
        self.now += gate.NOTIFY_REPEAT_S
        self.assertEqual(self.unlock(CODE_B)[0].status, 303)  # 1시간 뒤
        self.flush()
        self.assertEqual([m.split("\n")[0] for m in self.sent],
                         ["🔓 Macro — 잠금 해제", "🔓 Wakeline — 잠금 해제", "🔓 Macro — 잠금 해제"])
        self.assertIn("코드: acme", self.sent[2])

    def test_ip_rotation_does_not_flood_alerts(self):
        # 같은 /64 안에서 주소만 바꿔 가며 해제 — 응답은 모두 그대로, 알림은 상한까지
        self.start()
        with mock.patch.object(gate, "NOTIFY_UNLOCK_MAX", 3):
            for i in range(5):
                self.assertEqual(self.unlock(CODE_A, ip=f"2001:db8:1:2::{i:x}")[0].status, 303)
            self.flush()
            self.assertEqual(len(self.sent), 3)
            self.now += gate.NOTIFY_UNLOCK_WINDOW_S
            self.assertEqual(self.unlock(CODE_A, ip="2001:db8:1:2::ff")[0].status, 303)
            self.flush()
        self.assertEqual(len(self.sent), 4)
        self.assertIn("그 사이 알리지 못한 잠금 해제 2건", self.sent[3])

    def test_ip_lock_notified_once(self):
        self.start()
        for _ in range(gate.IP_MAX_FAILS - 1):
            self.assertEqual(self.unlock("wrong-code")[0].status, 401)
        self.flush()
        self.assertEqual(self.sent, [])
        res, data = self.unlock("wrong-code", headers={"User-Agent": CHROME_WIN})  # 잠기는 시도 — 응답은 전과 같다
        self.assertEqual(res.status, 401)
        self.assertIn("올바르지 않습니다", data.decode())
        for code in ("wrong-code", "wrong-code", CODE_A):  # 잠긴 동안의 거절은 알리지 않는다
            self.assertEqual(self.unlock(code)[0].status, 429)
        self.flush()
        self.assertEqual(len(self.sent), 1)
        self.assertTrue(self.sent[0].startswith(f"⛔ Macro — 접근 코드 {gate.IP_MAX_FAILS}회 실패\n"))
        self.assertIn("IP: 203.0.113.x", self.sent[0])
        self.assertIn("기기: Chrome · Windows", self.sent[0])

    def test_global_lock_notified_once(self):
        self.start()
        with mock.patch.object(gate, "GLOBAL_MAX_FAILS", 6):  # 요청 수를 줄이려고 전체 한도만 작게
            for i in range(6):
                self.assertEqual(self.unlock("wrong-code", ip=f"198.51.100.{i}")[0].status, 401)
            for i in range(3):
                self.assertEqual(self.unlock(CODE_A, ip=f"192.0.2.{i}")[0].status, 429)
            self.flush()
        self.assertEqual(len(self.sent), 1)
        self.assertTrue(self.sent[0].startswith("🚨 Macro — 전체 잠금\n1시간 안에 6회 틀려 30분 동안"))

    def test_slow_sender_does_not_hold_responses(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def held(text):
            entered.set()
            release.wait(self.WAIT_S)  # 응답이 이것을 기다리면 아래 요청이 시간 초과(10 s)로 실패한다
            self.sent.append(text)

        log = self.start(held, queue_size=1)
        self.assertEqual(self.unlock(CODE_A, ip="192.0.2.1")[0].status, 303)
        self.assertTrue(entered.wait(5))
        for ip in ("192.0.2.2", "192.0.2.3"):  # 하나는 큐에, 하나는 버림
            res, _ = self.unlock(CODE_A, ip=ip)
            self.assertEqual(res.status, 303)
            self.assertTrue(res.getheader("Set-Cookie").startswith("__Host-pf_gate="))
        self.assertIn('"event": "telegram_dropped"', log.getvalue())
        release.set()
        self.flush()
        self.assertEqual([m.split("\n")[3] for m in self.sent], ["IP: 192.0.2.x"] * 2)

    def test_failing_sender_does_not_change_responses(self):
        def failing(text):
            raise OSError(f"bot{TOKEN} unreachable")

        log = self.start(failing)
        res, _ = self.unlock(CODE_A)
        self.assertEqual(res.status, 303)
        self.assertIsNotNone(res.getheader("Set-Cookie"))
        statuses = [self.unlock("wrong-code", ip="192.0.2.9")[0].status for _ in range(gate.IP_MAX_FAILS + 1)]
        self.assertEqual(statuses, [401] * gate.IP_MAX_FAILS + [429])
        self.flush()
        self.assertEqual(log.getvalue().count('"error": "OSError"'), 2)
        self.assertNotIn(TOKEN, log.getvalue())

    def test_broken_notifier_does_not_change_responses(self):
        log = self.start()
        self.notifier.clock = mock.Mock(side_effect=RuntimeError("clock"))
        self.assertEqual(self.unlock(CODE_A)[0].status, 303)
        statuses = [self.unlock("wrong-code", ip="192.0.2.9")[0].status for _ in range(gate.IP_MAX_FAILS + 1)]
        self.assertEqual(statuses, [401] * gate.IP_MAX_FAILS + [429])
        self.assertEqual(log.getvalue().count('"event": "telegram_error"'), 2)

    def test_real_transport_from_config_logs_no_secret(self):
        log = self.start(cfg=make_config(telegram_token=TOKEN, telegram_chat_id=CHAT_ID), notifier=False)
        error = urllib.error.HTTPError(f"https://api.telegram.org/bot{TOKEN}/sendMessage", 429, "Too Many Requests",
                                       {}, io.BytesIO(b"{}"))
        with mock.patch.object(gate.urllib.request, "urlopen", side_effect=error) as urlopen:
            res, _ = self.unlock(CODE_A, headers={"User-Agent": CHROME_WIN})
            self.assertEqual(res.status, 303)
            self.flush()
        self.assertEqual(urlopen.call_count, 1)
        body = json.loads(urlopen.call_args.args[0].data)
        self.assertEqual(body["chat_id"], CHAT_ID)
        self.assertIn("IP: 203.0.113.x", body["text"])
        self.assertIn('"status": 429', log.getvalue())
        self.assertNotIn(TOKEN, log.getvalue())
        self.assertNotIn(CHAT_ID, log.getvalue())


class RetryTextTest(unittest.TestCase):
    """429 안내는 실제로 기다릴 시간을 말한다 — 결과를 기다리는 시도 때문의 5 s 를 '약 1분'으로 말하지 않는다(독립 리뷰 2026-10-14)."""

    def test_short_wait_is_said_in_seconds(self):
        self.assertEqual(gate.retry_text(gate.IN_FLIGHT_RETRY_S), "약 5초 뒤에")
        self.assertEqual(gate.retry_text(0.4), "약 1초 뒤에")

    def test_lockout_is_said_in_minutes(self):
        self.assertEqual(gate.retry_text(1800), "약 30분 뒤에")
        self.assertEqual(gate.retry_text(61), "약 1분 뒤에")


if __name__ == "__main__":
    unittest.main()
