// scripts/qa/ui-audit.test.js — 화면 감사 스크립트의 순수 함수 시험(의존성 없음 — Node 내장 node:test).
//   node --test scripts/qa/ui-audit.test.js
// 본문 스크롤 상자 고르기(choosePageScroller): 본문 뿌리 <main>을 품은 상자 우선(진행 기록 '통합 판단 거리' 12 — /status 넓은 화면에서 로그 상자를
// 본문으로 골라 화면 높이를 로그 길이로 적었음).
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { choosePageScroller } = require('./ui-audit.js');

const VIEW = { innerHeight: 900, width: 1440, docScrolls: false };

/** 세로 스크롤 상자 하나(node는 이름 — 고른 것을 이름으로 봄). */
const box = (node, clientHeight, scrollHeight, { clientWidth = 1200, containsMain = false } = {}) => ({
  node, clientHeight, clientWidth, scrollHeight, containsMain,
});

test('본문(<main>)이 넘치면, 본문 안의 더 긴 스크롤 상자(로그 상자 — 높이 한도 30rem)가 있어도 본문을 고른다', () => {
  const boxes = [box('main', 852, 8640, { containsMain: true }), box('log', 480, 10826, { clientWidth: 1100 })];
  assert.equal(choosePageScroller(boxes, VIEW), 'main');
});

test('본문이 창에 다 들어가면 본문 안의 넘친 상자를 고르지 않는다(null — 화면 높이는 문서 높이)', () => {
  const boxes = [box('main', 852, 852, { containsMain: true }), box('log', 480, 10826)];
  assert.equal(choosePageScroller(boxes, VIEW), null);
});

test('<main>을 품은 바깥 상자가 스크롤하면 그것을 고른다(본문 뿌리 — 자신이 아니어도 품으면 됨)', () => {
  const boxes = [box('shell-scroll', 852, 4000, { containsMain: true }), box('inner', 600, 9000)];
  assert.equal(choosePageScroller(boxes, VIEW), 'shell-scroll');
});

test('<main>을 품은 상자가 여럿이면 넘친 것 가운데 가장 긴 것', () => {
  const boxes = [box('outer', 900, 900, { containsMain: true }), box('main', 852, 5000, { containsMain: true })];
  assert.equal(choosePageScroller(boxes, VIEW), 'main');
});

test('<main>을 품은 후보가 없으면 예전 규칙 — 넘친 상자 가운데 가장 긴 것', () => {
  const boxes = [box('a', 600, 3000), box('b', 700, 5000), box('c', 800, 800)];
  assert.equal(choosePageScroller(boxes, VIEW), 'b');
});

test('창 높이·폭의 절반보다 작은 상자는 후보가 아니다 — <main>을 품어도', () => {
  const boxes = [box('small-root', 400, 9000, { containsMain: true }), box('narrow', 800, 9000, { clientWidth: 700 }), box('ok', 800, 2000)];
  assert.equal(choosePageScroller(boxes, VIEW), 'ok');
});

test('문서가 스크롤하면 고르지 않는다(좁은 화면 — 문서가 본문)', () => {
  const boxes = [box('main', 852, 8640, { containsMain: true })];
  assert.equal(choosePageScroller(boxes, { ...VIEW, docScrolls: true }), null);
});

test('넘침 1px 이하는 넘친 것으로 보지 않는다', () => {
  assert.equal(choosePageScroller([box('main', 852, 853, { containsMain: true })], VIEW), null);
  assert.equal(choosePageScroller([box('main', 852, 854, { containsMain: true })], VIEW), 'main');
});

test('문자열로 페이지에 보내도 그대로 돈다(바깥 이름을 쓰지 않음 — auditRoute가 toString으로 보냄)', () => {
  // Function으로 다시 만들어 바깥 범위 없이 부릅니다.
  const revived = new Function(`return (${choosePageScroller.toString()});`)();
  const boxes = [box('main', 852, 8640, { containsMain: true }), box('log', 480, 10826)];
  assert.equal(revived(boxes, VIEW), 'main');
});
