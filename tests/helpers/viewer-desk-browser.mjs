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
  // Move backward for an earlier queue control rather than visiting the browser
  // toolbar, which legitimately causes window blur/refocus and its 600 ms guard.
  const key = await control.evaluate(node => document.activeElement.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING ? 'Shift+Tab' : 'Tab');
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press(key);
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
    await tabTo(page, queue('B')); await page.keyboard.press('Space'); await expectCard('B');
    assert.equal(count(), 0); assert.equal(writes, 0);
    await tabTo(page, page.getByRole('button', { name: '写文字答复 · t' })); await page.keyboard.press('Space');
    await page.getByRole('textbox', { name: '文字答复', exact: true }).waitFor();
    assert.equal(count(), 0); assert.equal(writes, 0);
    await tabTo(page, page.getByRole('button', { name: '取消', exact: true })); await page.keyboard.press('Enter');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    await tabTo(page, page.locator('.desk-question .desk-option').nth(1));
    await page.keyboard.press('Space'); await expectCard('A');
    assert.equal(questions().find(q => q.ticketId === 'B').currentAnswer.choice.option, 2);
    await tabTo(page, page.locator('.desk-question .desk-option').nth(2)); await page.keyboard.press('Space'); await expectCard('C');
    assert.equal(questions().find(q => q.ticketId === 'A').currentAnswer.choice.option, 3);
    await queue('C').click(); await page.keyboard.press('Enter'); await page.locator('.desk-summary').getByText(/已答 3/).waitFor();
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
    await tabTo(page, queue('D')); await page.keyboard.press('Space'); await expectCard('D');
    assert.equal(count(), before); assert.equal(writes, beforeWrites);
    await page.keyboard.press('1'); await expectCard('E');
    const latest = questions().find(q => q.ticketId === 'D' && q.questionVersion === 2);
    assert.equal(latest.currentAnswer.choice.label, 'Three');

    // Withdrawal without a replacement (empty queue) must stay paused when a new question arrives.
    await mutate([withdraw('E')]); await interrupted.waitFor();
    await mutate([create('F', 'F', 'Question F?'), claim('F'), posted('F')]); await queue('F').waitFor();
    assert(await interrupted.isVisible());
    await bodyKey('Enter'); assert.equal(count(), before + 1); assert.equal(writes, beforeWrites + 1);
    await tabTo(page, queue('F')); await page.keyboard.press('Space'); await expectCard('F');
    assert.equal(count(), before + 1);
    await page.keyboard.press('2'); await page.locator('.desk-summary').getByText(/已答 5/).waitFor();
    // Settlement of the answer being edited also requires deliberate navigation.
    await page.locator('.desk-answer').filter({ hasText: 'Question B?' }).getByRole('button', { name: '修改答复' }).click();
    fakeTime += 15000; storage.desk.takeEligible(id, 'synthetic-worker');
    await mutate([settle('B', questions().find(q => q.ticketId === 'B').currentAnswer)]); await interrupted.waitFor();
    await bodyKey('Enter'); assert.equal(count(), before + 2); assert.equal(writes, beforeWrites + 2);
    // Acknowledge with an empty queue so settled-history actions do not stay locked forever.
    await tabTo(page, page.getByRole('button', { name: '已了解，查看当前题目', exact: true })); await page.keyboard.press('Space');
    await page.getByRole('heading', { name: '当前没有待答题', exact: true }).waitFor();
    assert(await page.getByRole('button', { name: '请求重开', exact: true }).isEnabled());
    assert.equal(count(), before + 2); assert.equal(writes, beforeWrites + 2);
    // New arrivals on the empty desk are paused, but an explicit option click
    // answers the displayed question and advances to the next pending question.
    await mutate(['H', 'I'].flatMap(name => [create(name, name, `Question ${name}?`), claim(name), posted(name)]));
    await expectCard('H'); assert.equal(await page.locator('.desk').getAttribute('data-shortcuts'), 'paused');
    await page.locator('.desk-question .desk-option').nth(1).click(); await expectCard('I');
    assert.equal(questions().find(q => q.ticketId === 'H').currentAnswer.choice.option, 2);
    assert.equal(count(), before + 3); assert.equal(writes, beforeWrites + 3);
    await page.locator('.desk[data-shortcuts=armed]').waitFor();
  } finally { await page.close(); }
}
async function verifyFocusAcrossPolling(context, origin, key) {
  for (const armed of [false, true]) for (const change of ['publication', 'taken']) for (const focus of ['text', 'queue', 'option']) {
    const id = `Synthetic.Poll.${armed}.${change}.${focus}`;
    const created = prepareCreate({ id, title: 'Polling focus regression', destination: 'No unintended answers', author });
    assert.equal(created.kind, 'ok'); await storage.adapter.commit(created.value);
    const mutate = commands => apply(commands, undefined, id);
    await mutate(['A', 'B', 'Source'].flatMap(name => [create(name, name, `Question ${name}?`), claim(name), post(name, 'One')]));
    assert.equal(storage.desk.submitAnswers(id, [{ questionId: 'Q.Source', questionVersion: 1, choice: { option: 1 } }]).kind, 'updated');
    const count = () => storage.desk.read(id).answers.length;
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    let writes = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/desk')) writes++; });
    const queue = name => page.locator('.desk-queue-item').filter({ hasText: `Question ${name}?` });
    const nextPoll = () => page.waitForResponse(response => response.url().includes(`/api/maps/${id}/view?`));
    try {
      await page.goto(`${origin}/maps/${id}#key=${key}`);
      await page.locator('.desk-question h2').getByText('Question A?', { exact: true }).waitFor();
      if (armed) await queue('A').click();
      const control = focus === 'text' ? page.getByRole('button', { name: '写文字答复 · t' })
        : focus === 'queue' ? queue('B') : page.locator('.desk-question .desk-option').nth(1);
      await tabTo(page, control);
      const before = count();
      if (change === 'publication') {
        await mutate([create('C', 'C', 'Question C?'), claim('C'), post('C', 'One')]);
        await queue('C').waitFor();
      } else {
        const revision = (await storage.adapter.readCurrent(id)).value.currentRevision;
        fakeTime += 15000; storage.desk.takeEligible(id, 'synthetic-worker');
        await page.locator('.desk-answer.taken').filter({ hasText: 'Source' }).waitFor();
        assert.equal((await storage.adapter.readCurrent(id)).value.currentRevision, revision);
      }
      await page.keyboard.press('Enter');
      if (armed) {
        await page.locator('.desk-answer.answered').filter({ hasText: 'Question A?' }).waitFor();
        assert.equal(count(), before + 1); assert.equal(writes, 1);
        const questions = storage.desk.inspect(id).desk.deskQuestions;
        assert.equal(questions.find(q => q.ticketId === 'A').currentAnswer.choice.option, 1);
        assert.equal(questions.find(q => q.ticketId === 'B').currentAnswer, null);
        console.log(`Armed polling focus passed: ${change}/${focus}`);
        continue;
      }
      await nextPoll();
      assert.equal(count(), before, `${change}/${focus}: Enter stored an answer after polling`);
      assert.equal(writes, 0, `${change}/${focus}: Enter sent a write after polling`);
      // A later poll or clicking empty space must not silently re-enable shortcuts.
      await page.locator('body').click({ position: { x: 2, y: 2 } });
      for (const shortcut of ['Enter', '1', '2', '3', 't']) await page.keyboard.press(shortcut);
      await nextPoll();
      assert.equal(count(), before); assert.equal(writes, 0);
      assert.equal(await page.locator('dialog[open]').count(), 0);
      // Explicitly choosing B with Space resumes shortcuts without submitting.
      await tabTo(page, queue('B')); await page.keyboard.press('Space');
      await page.locator('.desk-question h2').getByText('Question B?', { exact: true }).waitFor();
      assert.equal(count(), before); assert.equal(writes, 0);
      await page.keyboard.press('2');
      await page.locator('.desk-answer').filter({ hasText: 'Question B?' }).waitFor();
      assert.equal(storage.desk.inspect(id).desk.deskQuestions.find(q => q.ticketId === 'B').currentAnswer.choice.option, 2);
      assert.equal(count(), before + 1); assert.equal(writes, 1);
      console.log(`Polling focus passed: ${change}/${focus}`);
    } finally { await page.close(); }
  }
}
async function verifyDialogRearming(context, origin, key) {
  // Preserve all 27 dialog/poll/close interleavings. Closing never answers; the
  // displayed question becomes answerable after the delay, independent of focus.
  for (const kind of ['text', 'bulk', 'reopen']) for (const change of ['publication', 'taken', 'none']) for (const close of ['escape', 'cancel', 'confirm']) {
    const id = `Synthetic.Dialog.${kind}.${change}.${close}`;
    const created = prepareCreate({ id, title: 'Dialog selection regression', destination: 'No unintended answers', author });
    assert.equal(created.kind, 'ok'); await storage.adapter.commit(created.value);
    const mutate = commands => apply(commands, undefined, id);
    await mutate(['A', 'B', 'Source'].flatMap(name => [create(name, name, `Question ${name}?`), claim(name), post(name, 'One', name === 'B' ? 'followRecommendation' : 'needsKun')]));
    await mutate([create('Previous', 'Previous', 'Previous?'), claim('Previous'), settle('Previous')]);
    storage.desk.submitAnswers(id, [{ questionId: 'Q.Source', questionVersion: 1, choice: { option: 1 } }]);
    const count = () => storage.desk.read(id).answers.length;
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    let writes = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/desk')) writes++; });
    const queue = name => page.locator('.desk-queue-item').filter({ hasText: `Question ${name}?` });
    const paused = page.locator('.desk > .desk-warning');
    const nextPoll = () => page.waitForResponse(response => response.url().includes(`/api/maps/${id}/view?`));
    try {
      await page.goto(`${origin}/maps/${id}#key=${key}`); await queue('A').click();
      if (kind === 'text') {
        await page.getByRole('button', { name: '写文字答复 · t' }).click();
        await page.getByRole('textbox', { name: '文字答复', exact: true }).fill('Explicit text answer');
      } else if (kind === 'bulk') {
        await page.locator('.desk-bulk summary').click(); await page.locator('.desk-bulk input').check();
        await page.getByRole('button', { name: '查看所选完整答案并确认' }).click();
      } else {
        await page.getByRole('button', { name: '请求重开', exact: true }).click();
        await page.getByRole('textbox', { name: '重开原因和希望的答案' }).fill('Explicit reopen request');
      }
      if (change === 'publication') {
        await mutate([create('C', 'C', 'Question C?'), claim('C'), post('C', 'One')]); await queue('C').waitFor();
      } else if (change === 'taken') {
        fakeTime += 15000; storage.desk.takeEligible(id, 'synthetic-worker');
        await page.locator('.desk-answer.taken').filter({ hasText: 'Source' }).waitFor();
      }
      assert(await page.locator('dialog').evaluate(d => d.contains(document.activeElement)), 'Polling must preserve dialog focus');
      if (close === 'escape') await page.keyboard.press('Escape');
      else if (close === 'cancel') await page.getByRole('button', { name: '取消', exact: true }).click();
      else await page.getByRole('button', { name: kind === 'text' ? '提交文字答复' : kind === 'bulk' ? '确认这 1 题的完整推荐答案' : '提交重开请求', exact: true }).click();
      await page.locator('dialog[open]').waitFor({ state: 'detached' });
      // Wait for the explicit write's refresh to finish before measuring the next key.
      if (close === 'confirm') await page.locator('.desk-question .desk-option').first().waitFor();
      const before = count(), beforeWrites = writes;
      assert.equal(before, 1 + Number(close === 'confirm' && kind !== 'reopen'));
      assert.equal(beforeWrites, Number(close === 'confirm'));
      for (const shortcut of ['Enter', '1', '2', '3', 't']) await page.keyboard.press(shortcut);
      assert(await paused.isVisible());
      await nextPoll();
      assert.equal(count(), before, `${kind}/${change}/${close}: shortcut stored an extra answer`);
      assert.equal(writes, beforeWrites, `${kind}/${change}/${close}: shortcut sent an extra POST`);
      assert.equal(await page.locator('dialog[open]').count(), 0);
      const target = kind === 'text' && close === 'confirm'
        ? storage.desk.inspect(id).desk.deskQuestions.find(q => q.state === 'pending').ticketId : 'A';
      await page.locator('.desk[data-shortcuts=armed]').waitFor();
      assert.equal(await page.locator('.desk-question').getAttribute('data-question-id'), `Q.${target}`);
      assert.equal(writes, beforeWrites); assert(!(await paused.isVisible()));
      await page.keyboard.press('Enter');
      await page.locator('.desk-answer.answered').filter({ hasText: `Question ${target}?` }).waitFor();
      assert.equal(count(), before + 1); assert.equal(writes, beforeWrites + 1);
      console.log(`Dialog selection passed: ${kind}/${change}/${close}`);
    } finally { await page.close(); }
  }
}

async function verifyContinuousKeyboard(browser, origin, key) {
  // A separate browser context owns this clock. HTTP/SQLite are real; only the
  // browser's 600 ms guard is advanced deterministically.
  const context = await browser.newContext(); const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const clockStart = new Date('2026-10-27T12:00:00Z');
  await page.clock.install({ time: clockStart }); await page.clock.pauseAt(clockStart);
  const id = 'Synthetic.Continuous';
  const created = prepareCreate({ id, title: 'Continuous keyboard', destination: 'Answer only the displayed publication', author });
  assert.equal(created.kind, 'ok'); await storage.adapter.commit(created.value);
  const mutate = commands => apply(commands, undefined, id);
  const posted = (name, extra = {}) => post(name, 'One', 'needsKun', { options: [
    { label: 'One', description: 'First' }, { label: 'Two', description: 'Second' }, { label: 'Three', description: 'Third' },
  ], ...extra });
  const withdraw = (name, version = 1) => ({ kind: 'deskQuestion.withdraw', ticketId: name,
    claimantId: 'synthetic-worker', questionId: `Q.${name}`, questionVersion: version, reason: 'Changed premise' });
  await mutate(['A', 'B', 'C', 'D', 'E', 'F', 'G'].flatMap(name => [create(name, name, `Question ${name}?`), claim(name), posted(name)]));
  await mutate([create('Previous', 'Previous', 'Previous?'), claim('Previous'), settle('Previous')]);
  const answers = () => storage.desk.read(id).answers;
  const queue = name => page.locator('.desk-queue-item').filter({ hasText: `Question ${name}?` });
  const mode = () => page.locator('.desk').getAttribute('data-shortcuts');
  const current = () => page.locator('.desk-question').getAttribute('data-question-id');
  const waitMode = state => page.locator(`.desk[data-shortcuts=${state}]`).waitFor();
  let pollNumber = 0, writes = 0;
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/desk', async route => {
    const body = route.request().postDataJSON(); writes++;
    if (body.action === 'answer') {
      const shown = await page.locator('.desk-question').evaluate(card => ({
        questionId: card.dataset.questionId, questionVersion: Number(card.dataset.questionVersion),
      }));
      assert.equal(body.submissions.length, 1);
      assert.deepEqual({ questionId: body.submissions[0].questionId, questionVersion: body.submissions[0].questionVersion }, shown);
    }
    await route.continue();
  });
  async function poll(commands = []) {
    const title = `Poll ${++pollNumber}`;
    await mutate([...commands, { kind: 'map.update', patch: { title } }]);
    // Ask the existing poll loop to read now, without blurring or rearming.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
  }
  async function noShortcutWrites() {
    const before = writes, count = answers().length;
    for (const k of ['Enter', '1', '2', '3', 't']) await page.keyboard.press(k);
    assert.equal(writes, before); assert.equal(answers().length, count);
    assert.equal(await page.locator('dialog[open]').count(), 0);
  }
  async function finishDelay() {
    assert.equal(await mode(), 'waiting');
    assert(await page.locator('.desk-question.desk-shortcuts-waiting').isVisible());
    await page.clock.runFor(599); await noShortcutWrites(); assert.equal(await mode(), 'waiting');
    await page.clock.runFor(1); assert.equal(await mode(), 'armed');
  }
  async function refocus() {
    // Browsers can report both blur and hidden; the second event must not
    // overwrite the authority captured by the first.
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('blur'));
    });
    await noShortcutWrites();
    const refreshed = page.waitForResponse(r => r.url().includes(`/api/maps/${id}/view`));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await (await refreshed).finished();
  }
  try {
    await page.goto(`${origin}/maps/${id}#key=${key}`); await queue('A').waitFor();
    await page.clock.runFor(700); await noShortcutWrites(); assert.equal(await mode(), 'paused');
    await refocus(); await page.clock.runFor(1000); await noShortcutWrites();
    assert.equal(await mode(), 'paused', 'Refocus must not arm the initial unselected question');
    await tabTo(page, queue('A')); await page.keyboard.press('Space'); assert.equal(await mode(), 'armed');
    // Queue order changes do not replace the displayed A, even if G jumps first.
    await poll([withdraw('G'), posted('G', { gatesResearch: true })]);
    assert.equal(await current(), 'Q.A'); assert.equal(await mode(), 'armed');
    assert((await page.locator('.desk-queue-item').first().innerText()).includes('Question G?'));
    // Focus and root loss cannot retarget a shortcut. Enter on queue B answers A.
    await tabTo(page, queue('B')); await page.keyboard.press('Enter'); await waitMode('waiting');
    assert.equal(answers().length, 1); assert.equal(answers()[0].questionId, 'Q.A');
    assert.equal(await current(), 'Q.G');
    // A second, non-repeat Enter inside 600 ms must not answer the next question.
    await page.keyboard.press('Enter'); assert.equal(writes, 1); assert.equal(answers().length, 1);
    await page.locator('.desk-layout').screenshot({ path: join(output, 'shortcut-delay.png') });
    // Repeated unrelated publications/polls must neither reset nor complete the delay.
    for (let n = 0; n < 3; n++) {
      await poll([create(`Side${n}`, `Side${n}`, `Question Side${n}?`), claim(`Side${n}`), posted(`Side${n}`)]);
      await page.clock.runFor(150); assert.equal(await mode(), 'waiting');
    }
    await page.clock.runFor(149); await noShortcutWrites();
    await page.clock.runFor(1); assert.equal(await mode(), 'armed');
    // Keyboard-only progression: no selection or click between these answers.
    for (const k of ['2', '3', 'Enter']) {
      const target = await current(), count = answers().length;
      await poll(); assert.equal(await current(), target); assert.equal(await mode(), 'armed');
      await page.evaluate(() => document.activeElement.blur());
      assert.equal(await mode(), 'armed'); await page.keyboard.press(k); await waitMode('waiting');
      assert.equal(answers().length, count + 1); assert.equal(answers().at(-1).questionId, target);
      assert.equal(answers().at(-1).choice.option, k === 'Enter' ? 1 : Number(k));
      await finishDelay();
    }
    // Buttons cannot override the current recommendation or number/text shortcut.
    await page.locator('.desk-question .desk-option').nth(1).focus();
    await page.keyboard.press('t'); await page.getByRole('textbox', { name: '文字答复', exact: true }).waitFor();
    await page.keyboard.press('Escape'); await finishDelay();
    const beforeOption = answers().length, optionTarget = await current();
    await page.locator('.desk-question .desk-option').nth(2).focus(); await page.keyboard.press('Enter'); await waitMode('waiting');
    assert.equal(answers().length, beforeOption + 1); assert.equal(answers().at(-1).questionId, optionTarget);
    assert.equal(answers().at(-1).choice.option, 1); await finishDelay();
    // BODY and the main root preserve an already armed current question.
    await page.locator('body').click({ position: { x: 2, y: 2 } }); assert.equal(await mode(), 'armed');
    await page.evaluate(() => { const root = document.querySelector('#main'); root.tabIndex = -1; root.focus(); });
    assert.equal(await mode(), 'armed');
    // Same-question refocus reads first, then re-arms after the full delay.
    const refocusTarget = await current(), beforeRefocus = answers().length;
    await refocus(); await waitMode('waiting'); await finishDelay();
    await page.keyboard.press('Enter'); await waitMode('waiting');
    assert.equal(answers().length, beforeRefocus + 1); assert.equal(answers().at(-1).questionId, refocusTarget);
    // A delay already authorized by Kun resumes with a full guard after refocus.
    await page.clock.runFor(300); await refocus(); await waitMode('waiting'); await finishDelay();
    // File/cancel Reopen Requests keep the displayed question, with the same guard.
    const beforeRequests = writes, requestTarget = await current();
    await page.getByRole('button', { name: '请求重开', exact: true }).click();
    await page.getByRole('textbox', { name: '重开原因和希望的答案' }).fill('Reconsider');
    await page.getByRole('button', { name: '提交重开请求', exact: true }).click(); await waitMode('waiting');
    assert.equal(writes, beforeRequests + 1); assert.equal(await current(), requestTarget); await finishDelay();
    await page.getByRole('button', { name: '撤销重开请求', exact: true }).click(); await waitMode('waiting');
    assert.equal(writes, beforeRequests + 2); assert.equal(await current(), requestTarget); await finishDelay();
    // A changed current publication while unfocused remains paused across time,
    // refocus, further polls and dialog closure until explicitly reselected.
    const currentName = (await current()).slice(2);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await mutate([withdraw(currentName), posted(currentName)]);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('heading', { name: '问题已变，请重新选择题目后再回答。', exact: true }).waitFor();
    await page.clock.runFor(1000); await poll(); await noShortcutWrites(); assert.equal(await mode(), 'paused');
    await refocus(); await page.clock.runFor(1000); await noShortcutWrites(); assert.equal(await mode(), 'paused');
    await queue(currentName).click(); assert.equal(await mode(), 'armed');
    // A current question removed while a delay is pending cancels that timer.
    await page.keyboard.press('t'); await page.keyboard.press('Escape'); assert.equal(await mode(), 'waiting');
    await poll([withdraw(currentName, 2)]); await page.clock.runFor(1000); await noShortcutWrites();
    assert.equal(await mode(), 'paused');
    // Release the interruption, but merely displaying another default is unarmed.
    await page.getByRole('button', { name: '已了解，查看当前题目', exact: true }).click();
    await page.clock.runFor(1000); await noShortcutWrites(); assert.equal(await mode(), 'paused');
    await refocus(); await page.clock.runFor(1000); await noShortcutWrites();
    assert.equal(await mode(), 'paused', 'Acknowledging a change must still require selection after refocus');
    // A click that restores focus is an explicit selection. Hold the refocus
    // read to prove it waits for fresh state, then gets the full 600 ms guard.
    let releaseRead, readStarted;
    const heldRead = new Promise(resolve => { releaseRead = resolve; });
    const started = new Promise(resolve => { readStarted = resolve; });
    const viewRoute = `**/api/maps/${id}/view?*`;
    await page.route(viewRoute, async route => { readStarted(); await heldRead; await route.continue(); });
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
    await started; await page.locator('.desk-question h2').click();
    await page.clock.runFor(1000); await noShortcutWrites(); assert.equal(await mode(), 'paused');
    releaseRead(); await waitMode('waiting'); await finishDelay(); await page.unroute(viewRoute);
    // A different question ID must not inherit authority even at the same version.
    await queue('Side0').click();
    await poll([withdraw('Side0'), create('Replacement', 'Replacement', 'Question Replacement?'), claim('Replacement'), posted('Replacement')]);
    await page.clock.runFor(1000); await noShortcutWrites(); assert.equal(await mode(), 'paused');
    await queue('Replacement').click(); assert.equal(await current(), 'Q.Replacement'); assert.equal(await mode(), 'armed');
    // Closing a dialog cannot erase a current-publication change observed inside it.
    await page.keyboard.press('t');
    await poll([withdraw('Replacement'), posted('Replacement')]);
    assert(await page.getByRole('button', { name: '提交文字答复', exact: true }).isDisabled());
    await page.keyboard.press('Escape'); await page.clock.runFor(1000); await noShortcutWrites();
    assert.equal(await mode(), 'paused'); await queue('Replacement').click(); assert.equal(await mode(), 'armed');
    // Settlement of the currently edited answer is another external invalidation.
    await page.locator('.desk-answer').filter({ hasText: 'Question A?' }).getByRole('button', { name: '修改答复' }).click();
    fakeTime += 15000; storage.desk.takeEligible(id, 'synthetic-worker');
    await poll([settle('A', answers().find(a => a.questionId === 'Q.A'))]);
    await page.clock.runFor(1000); await noShortcutWrites(); assert.equal(await mode(), 'paused');
    assert.deepEqual(errors, []);
    console.log('Continuous keyboard passed: 599/600 ms, repeated polls, queue order, focus, dialogs, Reopen, refocus and external changes.');
  } finally { await context.close(); }
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
  const errors = [];
  context.on('page', page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('server responded with a status')) errors.push(message.text()); });
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
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
  await verifyContinuousKeyboard(browser, `http://127.0.0.1:${port}`, key);
  await verifyDialogRearming(context, `http://127.0.0.1:${port}`, key);
  await verifyFocusAcrossPolling(context, `http://127.0.0.1:${port}`, key);
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
  await page.locator('.desk-queue-item').filter({ hasText: '第一轮先验证多大范围？' }).click(); await page.keyboard.press('2');
  await page.locator('.desk-summary').getByText(/已答 2/).waitFor(); assert.equal(inspect().deskQuestions.find(q => q.ticketId === 'Scope').currentAnswer.choice.option, 2);
  await page.locator('.desk-queue-item').filter({ hasText: '要先做一轮方法比较吗？' }).click(); await page.keyboard.press('Enter');
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
  await page.keyboard.press('Enter');
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
  for (const fragment of ['#section', `#key=${key}`]) {
    await page.goto(`${url}${fragment}`); await page.locator('.map-drawing').waitFor();
    assert.equal(new URL(page.url()).hash, fragment);
    assert.equal(await page.locator('.desk').count(), 0);
  }
  assert.equal((await page.request.post(`http://127.0.0.1:${port}/api/desk`, { data: {} })).status(), 404);
  console.log('Browser evidence passed: light/dark/375px; fragment/storage; Tab/Space controls; 12 armed/unarmed polling/focus interleavings; 27 dialog interleavings; 599/600 ms continuous keyboard, root/revision/queue-order preservation and refocus/write/reopen delays; explicit selection and unchanged-poll positive controls; changed-question pause; keyboard/text/bulk/edit; live polling; stale reopen list; cancellation; Taken/Settled; requested-option marker and text context; restart; disabled UI and preserved fragments; no script/CSP errors across all pages.');
} finally {
  await browser?.close(); await service?.stop(); storage.close(); rmSync(directory, { recursive: true, force: true });
}
