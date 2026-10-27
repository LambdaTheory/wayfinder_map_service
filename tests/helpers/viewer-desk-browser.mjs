// Optional real-browser evidence, after npm run build. Uses only a new private cache database.
// WAYFINDER_PLAYWRIGHT_MODULE points to an installed playwright/index.mjs; no project dependency is added.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeSQLite, openSQLite } from '../../dist/sqlite-storage.js';
import { sqliteLifecycleForTests } from '../../dist/sqlite-internal.js';
import { serveLocalMcp } from '../../dist/mcp-http-internal.js';
import { prepareCreate, prepareApply } from '../../dist/index.js';
const { chromium } = await import(pathToFileURL(process.env.WAYFINDER_PLAYWRIGHT_MODULE).href);
const root = join(homedir(), 'Library/Caches/wayfinder-behaviour-tests'); mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'answer-desk-browser-'));
const databasePath = join(directory, 'private', 'maps.sqlite'); initializeSQLite(databasePath);
let fakeTime = Date.now();
const lifecycle = sqliteLifecycleForTests({ now: () => new Date(fakeTime).toISOString() });
let storage = lifecycle.open(databasePath); let service, browser;
const mapId = 'Synthetic.AnswerDesk';
const author = { actorId: 'synthetic', clientId: 'browser-check', occurredAt: '2026-10-27T00:00:00.000Z' };
const create = (id, title, question) => ({ kind: 'ticket.create', ticket: { id, title, question, type: 'grilling' } });
const claim = id => ({ kind: 'claim.acquire', ticketId: id, claimantId: 'synthetic-worker' });
const post = (id, label, triage = 'needsKun', extra = {}) => ({ kind: 'deskQuestion.post', ticketId: id, claimantId: 'synthetic-worker', question: {
  questionId: `Q.${id}`, options: [{ label, description: '先验证关键假设，再扩大范围。' }, { label: '一次覆盖全部', description: '准备时间较长，首轮即可比较完整结果。' }],
  recommendedOption: 1, recommendedAnswer: `选择「${label}」。第一轮只覆盖两个合成示例，记录结果后再决定是否扩展。`, whyKun: '范围会影响你投入的时间，需要你选择。',
  triage, triageReason: triage === 'needsKun' ? '投入与覆盖面的取舍' : '沿用已确认的方法，影响有限', gatesResearch: false, ...extra,
} });
const settle = (id, answer) => ({ kind: 'ticket.settle', ticketId: id, claimantId: 'synthetic-worker', ticketType: 'grilling',
  settlement: { outcome: { kind: 'decision', statement: '使用合成数据完成首轮验证', rationale: '范围已确认' }, evidence: [], references: [], provenance: { method: 'synthetic fixture', sources: [] }, extensions: {} },
  ...(answer ? { deskAnswer: { answerId: answer.answerId, questionVersion: answer.questionVersion } } : {}),
});
async function apply(commands, reopenRequestId, mapId = 'Synthetic.AnswerDesk') {
  const { value: state } = await storage.adapter.readCurrent(mapId);
  const p = prepareApply(state, { mapId, expectedRevision: state.currentRevision, commands, author, ...(reopenRequestId ? { reopenRequestId } : {}) }, storage.desk.read(mapId));
  assert.equal(p.kind, 'prepared', JSON.stringify(p));
  const result = await storage.adapter.commit(p.change); assert.equal(result.kind, 'committed', JSON.stringify(result));
}
const inspect = () => storage.desk.inspect(mapId).desk;
const answerCount = () => storage.desk.read(mapId).answers.length;
const free = createServer(); await new Promise(r => free.listen(0, '127.0.0.1', r)); const port = free.address().port; await new Promise(r => free.close(r));
assert(![18765, 18766].includes(port));
const keyPath = join(directory, 'private', 'browser-key');
const config = { databasePath, port, token: 'synthetic-browser-test-mcp-token-only', actorId: 'synthetic', clientId: 'browser-test', answerDeskEnabled: true, answerDeskKeyPath: keyPath };
const output = resolve(process.env.WAYFINDER_BROWSER_EVIDENCE_DIR ?? 'docs/implementation/answer-desk-viewer'); mkdirSync(output, { recursive: true });
async function tabTo(page, control) {
  // Exercise native focus traversal, not locator.focus() or a synthetic key event.
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    if (await control.evaluate(node => node === document.activeElement)) return;
  }
  assert.fail('Tab did not reach the requested control');
}
async function verifyFocusAndChangedQuestions(context, origin, key) {
  const id = 'Synthetic.Keyboard';
  const created = prepareCreate({ id, title: 'Keyboard regression', destination: 'No unintended answers', author });
  assert.equal(created.kind, 'ok'); await storage.adapter.commit(created.value);
  const mutate = commands => apply(commands, undefined, id);
  const count = () => storage.desk.read(id).answers.length;
  const questions = () => storage.desk.inspect(id).desk.deskQuestions;
  const posted = name => post(name, 'One', 'needsKun', { options: [
    { label: 'One', description: 'First' }, { label: 'Two', description: 'Second' }, { label: 'Three', description: 'Third' },
  ] });
  const withdraw = name => ({ kind: 'deskQuestion.withdraw', ticketId: name, claimantId: 'synthetic-worker', questionId: `Q.${name}`, questionVersion: 1, reason: 'Changed premise' });
  await mutate(['A', 'B', 'C'].flatMap(name => [create(name, name, `Question ${name}?`), claim(name), posted(name)]));
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  let writes = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/desk')) writes++; });
  const queue = name => page.locator('.desk-queue-item').filter({ hasText: `Question ${name}?` });
  const bodyKey = async key => { await page.locator('body').click({ position: { x: 2, y: 2 } }); await page.keyboard.press(key); };
  const expectCard = name => page.locator('.desk-question h2').getByText(`Question ${name}?`, { exact: true }).waitFor();
  try {
    await page.goto(`${origin}/maps/${id}#key=${key}`); await expectCard('A');
    await tabTo(page, queue('B')); await page.keyboard.press('Enter'); await expectCard('B');
    assert.equal(count(), 0); assert.equal(writes, 0);
    await tabTo(page, page.getByRole('button', { name: '写文字答复 · t' })); await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: '文字答复', exact: true }).waitFor();
    assert.equal(count(), 0); assert.equal(writes, 0);
    await tabTo(page, page.getByRole('button', { name: '取消', exact: true })); await page.keyboard.press('Enter');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    await tabTo(page, page.locator('.desk-question .desk-option').nth(1));
    await page.keyboard.press('1'); await page.keyboard.press('t');
    assert.equal(count(), 0); assert.equal(writes, 0); assert.equal(await page.locator('dialog[open]').count(), 0);
    await page.keyboard.press('Enter'); await expectCard('A');
    assert.equal(questions().find(q => q.ticketId === 'B').currentAnswer.choice.option, 2);
    await tabTo(page, page.locator('.desk-question .desk-option').nth(2)); await page.keyboard.press('Enter'); await expectCard('C');
    assert.equal(questions().find(q => q.ticketId === 'A').currentAnswer.choice.option, 3);
    await bodyKey('Enter'); await page.locator('.desk-summary').getByText(/已答 3/).waitFor();
    assert.equal(questions().find(q => q.ticketId === 'C').currentAnswer.choice.option, 1);

    // Replacement keeps the old reading context until a deliberate new selection.
    await mutate(['D', 'E'].flatMap(name => [create(name, name, `Question ${name}?`), claim(name), posted(name)]));
    await expectCard('D');
    const replacement = posted('D'); replacement.question.options.reverse();
    await mutate([withdraw('D'), replacement]);
    const interrupted = page.getByRole('heading', { name: '问题已变，请重新选择题目后再回答。', exact: true });
    await interrupted.waitFor();
    const before = count(), beforeWrites = writes;
    for (const key of ['Enter', '1', '2', '3', 't']) await bodyKey(key);
    assert.equal(count(), before); assert.equal(writes, beforeWrites);
    assert.equal(await page.locator('.desk-question .desk-option').count(), 0);
    assert.equal(await page.locator('dialog[open]').count(), 0);
    await mutate([{ kind: 'map.update', patch: { title: 'Still awaiting selection' } }]);
    await page.getByRole('heading', { name: 'Still awaiting selection', exact: true }).waitFor();
    assert(await interrupted.isVisible());
    await tabTo(page, queue('D')); await page.keyboard.press('Enter'); await expectCard('D');
    assert.equal(count(), before); assert.equal(writes, beforeWrites);
    await bodyKey('1'); await expectCard('E');
    const latest = questions().find(q => q.ticketId === 'D' && q.questionVersion === 2);
    assert.equal(latest.currentAnswer.choice.label, 'Three');

    // Withdrawal without a replacement (empty queue) must stay paused when a new question arrives.
    await mutate([withdraw('E')]); await interrupted.waitFor();
    await mutate([create('F', 'F', 'Question F?'), claim('F'), posted('F')]); await queue('F').waitFor();
    assert(await interrupted.isVisible());
    await bodyKey('Enter'); assert.equal(count(), before + 1); assert.equal(writes, beforeWrites + 1);
    await tabTo(page, queue('F')); await page.keyboard.press('Enter'); await expectCard('F');
    assert.equal(count(), before + 1);
    await bodyKey('2'); await page.locator('.desk-summary').getByText(/已答 5/).waitFor();
    // Settlement of the answer being edited also requires deliberate navigation.
    await page.locator('.desk-answer').filter({ hasText: 'Question B?' }).getByRole('button', { name: '修改答复' }).click();
    fakeTime += 15000; storage.desk.takeEligible(id, 'synthetic-worker');
    await mutate([settle('B', questions().find(q => q.ticketId === 'B').currentAnswer)]); await interrupted.waitFor();
    await bodyKey('Enter'); assert.equal(count(), before + 2); assert.equal(writes, beforeWrites + 2);
    // Acknowledge with an empty queue so settled-history actions do not stay locked forever.
    await tabTo(page, page.getByRole('button', { name: '已了解，查看当前题目', exact: true })); await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: '当前没有待答题', exact: true }).waitFor();
    assert(await page.getByRole('button', { name: '请求重开', exact: true }).isEnabled());
    assert.equal(count(), before + 2); assert.equal(writes, beforeWrites + 2);
  } finally { await page.close(); }
}
try {
  const created = prepareCreate({ id: mapId, title: '答题台 · 合成示例', destination: '验证关键选择，形成一份可以执行的计划', author });
  await storage.adapter.commit(created.value);
  await apply([
    create('Scope', '首轮范围', '第一轮先验证多大范围？'), claim('Scope'), post('Scope', '从两个示例开始'),
    create('Research', '比较方法', '要先做一轮方法比较吗？'), claim('Research'), post('Research', '先做小样本比较', 'needsKun', { gatesResearch: true }),
    create('Format', '记录格式', '验证结果按什么格式记录？'), claim('Format'), post('Format', '使用已有模板', 'followRecommendation'),
    create('Schedule', '复核节奏', '何时集中复核第一轮结果？'), claim('Schedule'), post('Schedule', '第一轮结束后复核', 'followRecommendation'),
    create('Next', '后续执行', '首轮范围确认后怎样执行？'), { kind: 'dependency.add', dependentId: 'Next', prerequisiteId: 'Scope' },
    create('Previous', '已经确认的数据来源', '验证使用哪些数据？'), claim('Previous'), settle('Previous'),
  ]);
  service = await serveLocalMcp(storage, config);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, colorScheme: 'light' });
  const page = await context.newPage(); page.setDefaultTimeout(10000); const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('server responded with a status')) errors.push(message.text()); });
  const key = readFileSync(keyPath, 'utf8'); const url = `http://127.0.0.1:${port}/maps/${mapId}`;
  await page.goto(`${url}#key=${key}`); await page.locator('.desk-question h2').waitFor();
  assert.equal(new URL(page.url()).hash, ''); assert.equal(answerCount(), 0);
  assert(!(await page.content()).includes(key));
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  await page.screenshot({ path: join(output, 'light.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: join(output, 'dark.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 }); await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(250); // Only for the viewer's documented resize debounce, never a domain race.
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(output, '375px.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 960 }); await page.waitForTimeout(250);
  await verifyFocusAndChangedQuestions(context, `http://127.0.0.1:${port}`, key);
  // Viewing and cancelling do nothing; whitespace is disabled; drafts survive desk-only polling.
  await page.locator('.desk-queue-item').filter({ hasText: '第一轮先验证多大范围？' }).click(); await page.keyboard.press('t');
  const text = page.getByRole('textbox', { name: '文字答复', exact: true }); await text.fill('  ');
  assert(await page.getByRole('button', { name: '提交文字答复', exact: true }).isDisabled());
  await text.fill('需要补充依据');
  storage.desk.submitAnswers(mapId, [{ questionId: 'Q.Format', questionVersion: 1, choice: { option: 1 } }]);
  await page.locator('.desk-summary').getByText(/已答 1/).waitFor(); assert.equal(await text.inputValue(), '需要补充依据');
  // A new Map Revision also preserves an open modal and its draft.
  await apply([{ kind: 'map.update', patch: { title: '答题台 · 合成示例（跟随更新）' } }]);
  await page.getByRole('heading', { name: '答题台 · 合成示例（跟随更新）', exact: true }).waitFor();
  assert(await page.locator('dialog').evaluate(d => d.matches(':modal'))); assert.equal(await text.inputValue(), '需要补充依据');
  await page.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(answerCount(), 1);
  // Key 2, Enter recommendation, then selected-only bulk confirmation.
  await page.locator('body').click({ position: { x: 2, y: 2 } }); await page.keyboard.press('2');
  await page.locator('.desk-summary').getByText(/已答 2/).waitFor(); assert.equal(inspect().deskQuestions.find(q => q.ticketId === 'Scope').currentAnswer.choice.option, 2);
  await page.locator('body').click({ position: { x: 2, y: 2 } }); await page.keyboard.press('Enter');
  await page.locator('.desk-summary').getByText(/已答 3/).waitFor();
  await page.locator('.desk-bulk summary').click(); await page.locator('.desk-bulk input').check();
  await page.getByRole('button', { name: '查看所选完整答案并确认' }).click(); assert.equal(answerCount(), 3);
  assert((await page.locator('dialog').innerText()).includes('第一轮只覆盖两个合成示例'));
  await page.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(answerCount(), 3);
  await page.getByRole('button', { name: '查看所选完整答案并确认' }).click();
  await page.getByRole('button', { name: '确认这 1 题的完整推荐答案' }).click();
  await page.locator('.desk-summary').getByText(/已答 4/).waitFor();
  // Edit a submitted answer, explicitly choose text, then see withdrawal history.
  await page.locator('.desk-answer').filter({ has: page.getByText('第一轮先验证多大范围？', { exact: true }) }).getByRole('button', { name: '修改答复' }).click();
  await page.getByRole('button', { name: '写文字答复 · t' }).click(); await text.fill('请提供比较材料');
  await page.getByRole('button', { name: '提交文字答复', exact: true }).click();
  await page.locator('.desk-history').getByText('请提供比较材料', { exact: true }).waitFor();
  await apply([{ kind: 'deskQuestion.withdraw', ticketId: 'Scope', claimantId: 'synthetic-worker', questionId: 'Q.Scope', questionVersion: 1, reason: '补充比较材料后重新提问' }]);
  await page.locator('.desk-answer.withdrawn s').waitFor();
  // Reopen conversation Settlement is text-only. A changed affected binding requires review.
  await page.locator('.desk-settled').getByRole('button', { name: '请求重开' }).click();
  assert((await page.locator('dialog').innerText()).includes('只能填写文字请求'));
  assert.equal(await page.locator('dialog .desk-option').count(), 0);
  await apply([create('Dependent', '受影响的决定', '后续怎么做？'), { kind: 'dependency.add', dependentId: 'Dependent', prerequisiteId: 'Previous' }, claim('Dependent'), settle('Dependent')]);
  await page.getByRole('button', { name: '重新查看当前清单' }).waitFor();
  await page.getByRole('textbox', { name: '重开原因和希望的答案' }).fill('更换来源');
  assert(await page.getByRole('button', { name: '提交重开请求', exact: true }).isDisabled());
  assert.equal(storage.desk.read(mapId).reopenRequests.length, 0);
  await page.getByRole('button', { name: '重新查看当前清单' }).click();
  assert((await page.locator('dialog').innerText()).includes('Dependent · 受影响的决定'));
  await page.getByRole('textbox', { name: '重开原因和希望的答案' }).fill('更换来源');
  await page.getByRole('button', { name: '提交重开请求', exact: true }).click();
  await page.getByRole('button', { name: '撤销重开请求' }).waitFor();
  await page.getByRole('button', { name: '撤销重开请求' }).click(); await page.getByRole('button', { name: '撤销重开请求' }).waitFor({ state: 'detached' });
  // Controlled clock: Taken/Settled and handled-request preselection/text are read from the real storage projection.
  await apply([create('Requested', '重开的目标', '重开后确认哪个方案？'), claim('Requested'), post('Requested', '小范围验证')]);
  const sourceAnswer = storage.desk.submitAnswers(mapId, [{ questionId: 'Q.Requested', questionVersion: 1, choice: { option: 1 } }]).value[0];
  fakeTime += 15000; storage.desk.takeEligible(mapId, 'synthetic-worker');
  await page.locator('.desk-answer.taken').filter({ hasText: 'Requested' }).waitFor();
  await apply([settle('Requested', sourceAnswer)]);
  await page.locator('.desk-answer.settled').filter({ hasText: 'Requested' }).waitFor();
  await page.locator('.desk-settled .desk-answer').filter({ hasText: 'Requested' }).getByRole('button', { name: '请求重开' }).click();
  assert.equal(await page.locator('dialog .desk-option').count(), 2);
  assert(!(await page.locator('dialog').innerText()).includes('false'));
  await page.getByRole('button', { name: '取消', exact: true }).click();
  async function reopenRequested(requested) {
    const state = (await storage.adapter.readCurrent(mapId)).value;
    const target = state.tickets.find(t => t.id === 'Requested');
    const filed = storage.desk.fileReopenRequest(mapId, { ticketId: 'Requested', settlementIntroducedAtRevision: target.settlement.introducedAtRevision,
      affectedTickets: [], affectedSettlementRevisions: {}, requested });
    assert.equal(filed.kind, 'updated'); fakeTime += 15000; storage.desk.takeEligible(mapId, 'synthetic-worker');
    await apply([{ kind: 'ticket.reopen', ticketId: 'Requested', reason: 'Requested in browser' }, claim('Requested'), post('Requested', '小范围验证')], filed.value.requestId);
  }
  await reopenRequested({ option: 2, label: '一次覆盖全部', questionId: 'Q.Requested', questionVersion: 1 });
  const beforeMarker = answerCount();
  await page.locator('.desk-queue-item').filter({ hasText: '重开后确认哪个方案？' }).click();
  await page.locator('.desk-requested').getByText('Kun 要求：2 · 推荐：1。标记不是答案，仍需选择。', { exact: true }).waitFor();
  assert.equal(answerCount(), beforeMarker); assert.equal(inspect().deskQuestions.find(q => q.ticketId === 'Requested' && q.questionVersion === 2).currentAnswer, null);
  await page.locator('body').click({ position: { x: 2, y: 2 } }); await page.keyboard.press('Enter');
  await page.locator('.desk-answer.answered').filter({ hasText: 'Requested' }).waitFor();
  const confirmed = inspect().deskQuestions.find(q => q.ticketId === 'Requested' && q.questionVersion === 2).currentAnswer;
  assert.equal(confirmed.choice.option, 1); fakeTime += 15000; storage.desk.takeEligible(mapId, 'synthetic-worker');
  await apply([settle('Requested', confirmed)]);
  await reopenRequested({ text: '先补充成本比较，再给我选择。' });
  await page.locator('.desk-queue-item').filter({ hasText: '重开后确认哪个方案？' }).click();
  await page.getByText('Kun 要求重开：先补充成本比较，再给我选择。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '写文字答复 · t' }).click(); assert.equal(await text.inputValue(), '');
  await apply([{ kind: 'deskQuestion.withdraw', ticketId: 'Requested', claimantId: 'synthetic-worker', questionId: 'Q.Requested', questionVersion: 3, reason: '新材料改变了问题' }, post('Requested', '小范围验证')]);
  await page.getByText('问题已变或已结算，请取消并查看最新题目；本次没有提交。', { exact: true }).waitFor();
  await text.fill('这条旧题答复不应提交'); assert(await page.getByRole('button', { name: '提交文字答复', exact: true }).isDisabled());
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('.desk-answer.superseded_by_reopen').count(), 2);
  // Restart revokes the open page's key; the next click is refused and never retried.
  await service.stop(); storage = lifecycle.open(databasePath); service = await serveLocalMcp(storage, config);
  await page.locator('.desk-answer').filter({ has: page.getByText('验证结果按什么格式记录？', { exact: true }) }).getByRole('button', { name: '修改答复' }).click();
  const before = answerCount(); await page.locator('.desk-question .desk-option').first().click();
  await page.getByRole('status').filter({ hasText: '钥匙已失效' }).waitFor(); assert.equal(answerCount(), before);
  // Reload has no persisted key; keyed access does not transfer to another page.
  await page.reload(); await page.getByRole('button', { name: '答题台', exact: true }).click();
  await page.getByText('当前仅查看。', { exact: false }).waitFor(); assert(await page.locator('.desk-history').getByRole('button', { name: '修改答复' }).first().isDisabled());
  assert.deepEqual(errors, []);
  // Default off: same browser, fresh unused database, no desk UI or write route.
  await service.stop(); const disabledPath = join(directory, 'disabled', 'maps.sqlite'); initializeSQLite(disabledPath); storage = openSQLite(disabledPath);
  await storage.adapter.commit(created.value); service = await serveLocalMcp(storage, { ...config, databasePath: disabledPath, answerDeskEnabled: false });
  await page.getByRole('button', { name: '答题台', exact: true }).waitFor({ state: 'detached' });
  await page.locator('.map-drawing').waitFor();
  // On an unused database, enable then disable at the SAME Revision: an open page must remove the desk.
  await service.stop(); storage = openSQLite(disabledPath); service = await serveLocalMcp(storage, { ...config, databasePath: disabledPath });
  await page.getByRole('button', { name: '答题台', exact: true }).waitFor();
  await service.stop(); storage = openSQLite(disabledPath); service = await serveLocalMcp(storage, { ...config, databasePath: disabledPath, answerDeskEnabled: false });
  await page.getByRole('button', { name: '答题台', exact: true }).waitFor({ state: 'detached' });
  assert.equal(await page.locator('.desk').count(), 0);
  assert.equal((await page.request.post(`http://127.0.0.1:${port}/api/desk`, { data: {} })).status(), 404);
  console.log('Browser evidence passed: light/dark/375px; fragment/storage; Tab/Enter queue/text/options; changed-question pause and deliberate selection; keyboard/text/bulk/edit; live polling; stale reopen list; cancellation; Taken/Settled; requested-option marker and text context; restart; disabled UI.');
} finally {
  await browser?.close(); await service?.stop(); storage.close(); rmSync(directory, { recursive: true, force: true });
}
