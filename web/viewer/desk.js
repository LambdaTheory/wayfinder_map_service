// Human responses only. The capability stays in this closure, never in persistent page storage.
const SHORTCUT_ARM_DELAY_MS = 600;

export function createDesk({ h, mapId, key, refresh }) {
  const element = h('section', { class: 'desk', 'aria-label': '答题台' });
  const content = h('div');
  const status = h('p', { class: 'desk-feedback', role: 'status', 'aria-live': 'polite' });
  const shortcutPause = h('p', { class: 'desk-warning', role: 'status', tabindex: '-1', hidden: true });
  const dialog = h('dialog', { class: 'desk-dialog', 'aria-label': '确认答复' });
  element.append(status, shortcutPause, content, dialog);
  const names = { pending: '待答', answered: '已答 · 等待取走', taken: '已取走 · 等待结算', settled: '已结算', withdrawn: '已撤回', superseded_by_reopen: '已重开 · 旧题留档' };
  const live = q => ['pending', 'answered', 'taken'].includes(q.state);
  const identity = q => `${q.questionId}/${q.questionVersion}`;
  const choiceText = choice => !choice ? '尚未回答' : 'text' in choice ? choice.text : `${choice.option}. ${choice.label}`;
  let data = null, fingerprint = '', active = null, changedQuestion = null, busy = false, editor = null;
  let armedQuestion = null, armingQuestion = null, armTimer = null, externalPause = false, displayed = false;
  let inactive = false, focusCheck = 0, destroyed = false;
  const interactive = 'button,input,textarea,select,a,summary,[contenteditable],[role="button"],[role="link"]';
  const selected = new Set();
  const button = (label, fn, props = {}) => {
    const b = h('button', { type: 'button', ...props }, label); b.onclick = fn; return b;
  };
  const canWrite = () => !!key && !busy && !changedQuestion;
  const notice = message => { status.textContent = message; };
  const title = q => h('span', null, h('code', null, q.ticketId), ` · 第 ${q.questionVersion} 版`);
  const answer = (q, choice) => ({ questionId: q.questionId, questionVersion: q.questionVersion, choice });
  function updateShortcutUI() {
    const mode = armedQuestion === active && active ? 'armed' : armingQuestion === active && active ? 'waiting' : 'paused';
    element.dataset.shortcuts = mode;
    shortcutPause.hidden = !key || mode === 'armed';
    shortcutPause.textContent = mode === 'waiting'
      ? '当前题目已高亮，约 0.6 秒后可用 Enter / 1–3 / t 继续。'
      : '快捷键已暂停。请点击当前题目或在待答列表中选择题目后继续（Tab 定位，空格选题）。';
    const card = content.querySelector('.desk-question');
    card?.classList.toggle('desk-shortcuts-waiting', mode === 'waiting');
    card?.classList.toggle('desk-shortcuts-armed', mode === 'armed');
  }
  function pauseShortcuts() {
    clearTimeout(armTimer); armTimer = null; armedQuestion = null; armingQuestion = null; updateShortcutUI();
  }
  function armShortcuts(delayed = false) {
    pauseShortcuts();
    if (!key || !active || externalPause || changedQuestion || busy || dialog.open || inactive || destroyed) return;
    if (!delayed) armedQuestion = active;
    else {
      const target = active;
      armingQuestion = target;
      armTimer = setTimeout(() => {
        if (armingQuestion === target && active === target) armShortcuts();
      }, SHORTCUT_ARM_DELAY_MS);
    }
    updateShortcutUI();
  }
  function chooseQuestion(q) {
    pauseShortcuts(); changedQuestion = null; externalPause = false; active = q ? identity(q) : null; render(true);
    const card = content.querySelector('.desk-question');
    card.focus(); card.scrollIntoView({ block: 'nearest' });
    if (q && live(q)) armShortcuts();
  }
  function closeEditor(resume = true) {
    editor = null;
    if (dialog.open) {
      pauseShortcuts(); dialog.close();
      if (!element.hidden && key) shortcutPause.focus({ preventScroll: true });
      if (resume) armShortcuts(true);
    }
    dialog.replaceChildren();
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!busy) closeEditor(); });

  async function write(payload) {
    if (!canWrite()) return false;
    const currentAtStart = active;
    busy = true; pauseShortcuts(); render(); updateEditor();
    let ok = false;
    try {
      const response = await fetch('/api/desk', { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', 'X-Wayfinder-Key': key }, body: JSON.stringify({ ...payload, mapId }) });
      if (response.ok) { ok = true; notice('已提交。停手 15 秒后，agent 可以取走；结算由 agent 完成。'); }
      else {
        const { error } = await response.json();
        notice(({ question_changed: '问题已变，请重新回答；本次未提交。', list_changed: '影响清单已变，请重新核对；本次未提交。',
          key_required: '钥匙已失效，请用 wayfinder desk 重新打开。', request_not_pending: '请求已被取走，不能撤销。',
          not_found: '答题台未启用。', invalid_input: '答复无效，本次未提交。' })[error] ?? '未能确认提交结果，请查看最新状态后再决定是否重试。');
      }
    } catch { notice('连接中断，提交结果未知。请查看最新状态后再决定是否重试。'); }
    finally {
      if (ok) closeEditor(false);
      // No automatic retry: an unknown receipt may already have committed.
      let refreshed = false;
      try { await refresh(); refreshed = true; } catch { notice('连不上服务，显示的是上次看到的答复；提交结果请恢复连接后核对。'); }
      busy = false;
      const ownTransition = ok && refreshed && !externalPause && active === currentAtStart;
      if (ownTransition && payload.action === 'answer') active = null;
      render(ownTransition); updateEditor();
      if (ownTransition) armShortcuts(true);
    }
    return ok;
  }
  async function submit(q, choice) {
    await write({ action: 'answer', submissions: [answer(q, choice)] });
  }
  function openText(q) {
    if (!canWrite()) return;
    closeEditor(false); pauseShortcuts();
    const input = h('textarea', { rows: 5, 'aria-label': '文字答复', placeholder: '写下你的答案，或说明还需要哪些材料' });
    const save = button('提交文字答复', () => { if (input.value.trim()) submit(q, { text: input.value }); }, { disabled: true });
    const warning = h('p', { class: 'desk-warning', role: 'status' });
    editor = { kind: 'answer', q, input, save, warning };
    input.oninput = updateEditor;
    dialog.replaceChildren(h('h2', null, '文字答复'), h('p', null, q.question), title(q), input, warning,
      h('div', { class: 'desk-actions' }, button('取消', () => { if (!busy) closeEditor(); }), save));
    dialog.showModal(); input.focus();
  }
  function openBulk() {
    const questions = data.deskQuestions.filter(q => selected.has(identity(q)) && q.state === 'pending' && q.triage === 'followRecommendation');
    if (!canWrite() || !questions.length) return;
    closeEditor(false); pauseShortcuts();
    const save = button(`确认这 ${questions.length} 题的完整推荐答案`, async () => {
      if (await write({ action: 'answer', submissions: questions.map(q => answer(q, { option: q.recommendedOption })) })) selected.clear();
    });
    const warning = h('p', { class: 'desk-warning', role: 'status' });
    editor = { kind: 'bulk', questions, save, warning };
    dialog.replaceChildren(h('h2', null, '逐题核对后确认'), ...questions.map(q => h('article', null, title(q), h('h3', null, q.question),
      h('p', null, `${q.recommendedOption}. ${q.options[q.recommendedOption - 1].label}`), h('p', { class: 'desk-full-answer' }, q.recommendedAnswer))), warning,
      h('div', { class: 'desk-actions' }, button('取消', () => { if (!busy) closeEditor(); }), save));
    dialog.showModal();
  }
  function openReopen(target) {
    if (!canWrite()) return;
    closeEditor(false); pauseShortcuts();
    const warning = h('p', { class: 'desk-warning', role: 'status' });
    const body = h('div');
    editor = { kind: 'reopen', target, warning, body, controls: [] };
    dialog.replaceChildren(h('h2', null, '请求重开'), body, warning, button('取消', () => { if (!busy) closeEditor(); }));
    renderReopen(); dialog.showModal();
  }
  function renderReopen() {
    const target = editor.target;
    const requested = choice => write({ action: 'reopen', submission: {
      ticketId: target.ticketId, settlementIntroducedAtRevision: target.settlementIntroducedAtRevision,
      affectedTickets: target.affectedTickets, affectedSettlementRevisions: target.affectedSettlementRevisions, requested: choice,
    } });
    const input = h('textarea', { rows: 4, 'aria-label': '重开原因和希望的答案', placeholder: '希望怎样修改这个决定？' });
    const save = button('提交重开请求', () => { if (input.value.trim()) requested({ text: input.value }); }, { disabled: true });
    editor.input = input; editor.save = save; input.oninput = updateEditor;
    const options = target.source?.options.map((option, i) => button(`${i + 1}. ${option.label} — ${option.description}`, () => requested({
      option: i + 1, label: option.label, questionId: target.source.questionId, questionVersion: target.source.questionVersion,
    }), { class: 'desk-option' })) ?? [];
    editor.controls = options;
    editor.body.replaceChildren(h('h3', null, `${target.ticketId} · ${target.title}`),
      h('p', { class: 'desk-full-answer' }, target.settlement.outcome.statement),
      h('p', null, `将授权 agent 重开本题（结算于修订 ${target.settlementIntroducedAtRevision}）及以下已结算的依赖题：`),
      target.affectedDetails.length ? h('ul', null, target.affectedDetails.map(t => h('li', null,
        `${t.ticketId} · ${t.title}（结算于修订 ${target.affectedSettlementRevisions[t.ticketId]}）`))) : h('p', null, '没有受影响的已结算依赖题。'),
      h('p', null, '提交不会立即重开。agent 取走前可撤销；重开后仍需对新题重新作答。'), ...options,
      target.source ? '' : h('p', { class: 'desk-muted' }, '这次结算没有答题台题目，只能填写文字请求。'), input, save);
    updateEditor();
  }
  const binding = target => JSON.stringify([target?.settlementIntroducedAtRevision, target?.affectedTickets, target?.affectedSettlementRevisions]);
  function updateEditor() {
    if (!editor || !data) return;
    if (editor.kind === 'reopen') {
      const current = data.reopenTargets.find(t => t.ticketId === editor.target.ticketId);
      const changed = binding(current) !== binding(editor.target);
      editor.warning.replaceChildren(changed ? '影响清单已变，请重新核对；本次没有提交。' : '');
      if (changed && current) editor.warning.append(button('重新查看当前清单', () => { editor.target = current; renderReopen(); }));
      for (const b of editor.controls) b.disabled = changed || !canWrite();
      editor.save.disabled = changed || !canWrite() || !editor.input.value.trim();
    } else {
      const questions = editor.kind === 'bulk' ? editor.questions : [editor.q];
      const changed = questions.some(q => !data.deskQuestions.some(next => identity(next) === identity(q) && live(next)
        && (editor.kind !== 'bulk' || next.state === 'pending' && next.triage === 'followRecommendation')));
      editor.warning.textContent = changed ? '问题已变或已结算，请取消并查看最新题目；本次没有提交。' : '';
      editor.save.disabled = changed || !canWrite() || (editor.kind === 'answer' && !editor.input.value.trim());
    }
  }
  function questionCard(q) {
    if (changedQuestion) return h('article', { class: 'desk-question card-box', role: 'alert' },
      title(changedQuestion), h('h2', null, '问题已变，请重新选择题目后再回答。'),
      h('p', null, `刚才查看：${changedQuestion.question}`),
      h('p', null, '这道题已撤回、替换或结算。答复已暂停；请重新选题，或确认后查看当前题目。'),
      button('已了解，查看当前题目', () => chooseQuestion(null)));
    if (!q) return h('article', { class: 'desk-question card-box', tabindex: '-1' }, h('h2', null, '当前没有待答题'), h('p', { class: 'desk-muted' }, 'agent 发布新题后会出现在这里。已答题的处理进度在下方。'));
    const context = data.reopenContexts.find(c => c.ticketId === q.ticketId);
    const card = h('article', { class: 'desk-question card-box', tabindex: '-1',
      'data-question-id': q.questionId, 'data-question-version': q.questionVersion }, title(q), h('h2', null, q.question),
      h('p', { class: 'desk-impact' }, `解锁 ${q.immediateUnlocks} 题 · 下游未定 ${q.downstreamUnsettled} 题${q.gatesResearch ? ' · 决定是否开展长调研' : ''}`),
      h('p', null, h('strong', null, '为什么需要你：'), q.whyKun),
      h('p', { class: 'desk-muted' }, `${q.triage === 'needsKun' ? '需要你看' : '照推荐即可'} · ${q.triageReason}`),
      context && 'text' in context.requested && h('blockquote', null, `Kun 要求重开：${context.requested.text}`),
      q.requestedOption && h('p', { class: 'desk-requested' }, `Kun 要求：${q.requestedOption} · 推荐：${q.recommendedOption}。标记不是答案，仍需选择。`),
      h('div', { class: 'desk-recommendation' }, h('strong', null, `推荐 ${q.recommendedOption} · Enter 提交此推荐`), h('p', { class: 'desk-full-answer' }, q.recommendedAnswer)),
      q.currentAnswer && h('p', null, `当前答复：${choiceText(q.currentAnswer.choice)} · ${names[q.state]}`),
      h('div', { class: 'desk-options' }, q.options.map((option, i) => button([
        h('strong', null, `${i + 1}. ${option.label}`), h('span', null, option.description),
        i + 1 === q.recommendedOption && h('small', null, '推荐'), i + 1 === q.requestedOption && h('small', null, 'Kun 要求'),
      ], () => submit(q, { option: i + 1 }), { class: 'desk-option', disabled: !canWrite() }))),
      button('写文字答复 · t', () => openText(q), { disabled: !canWrite() }),
      h('p', { class: 'desk-muted' }, '点击选项即提交 · 快捷键只回答当前题：Enter 推荐 · 1–3 选择 · t 文字。Tab 定位按钮，空格操作。'));
    card.onclick = event => { if (!event.target.closest(interactive)) chooseQuestion(q); };
    return card;
  }
  function render(ownTransition = false) {
    if (!data) return;
    const losesFocus = content.contains(document.activeElement);
    const pending = data.deskQuestions.filter(q => q.state === 'pending');
    const current = changedQuestion ? null : data.deskQuestions.find(q => identity(q) === active && live(q)) ?? pending[0];
    const nextActive = current ? identity(current) : null;
    if (active !== nextActive) {
      pauseShortcuts();
      if (displayed && !ownTransition) externalPause = true;
    }
    active = nextActive; displayed = true;
    for (const id of selected) if (!pending.some(q => identity(q) === id && q.triage === 'followRecommendation')) selected.delete(id);
    const queue = h('nav', { class: 'desk-queue card-box', 'aria-label': '待答题' }, h('h2', null, `待答 · ${pending.length}`));
    let group;
    for (const q of pending) {
      const nextGroup = q.immediateUnlocks > 0 || q.gatesResearch ? '先答能解锁的' : q.triage === 'needsKun' ? '需要你看' : '照推荐即可';
      if (nextGroup !== group) { queue.append(h('h3', null, nextGroup)); group = nextGroup; }
      queue.append(button([h('strong', null, q.question), h('span', null, `${q.ticketId} · 解锁 ${q.immediateUnlocks} · 下游 ${q.downstreamUnsettled}`)],
        () => chooseQuestion(q), { class: 'desk-queue-item', 'aria-current': identity(q) === active ? 'true' : 'false' }));
    }
    const easy = pending.filter(q => q.triage === 'followRecommendation');
    const bulk = h('details', { class: 'desk-bulk card-box' }, h('summary', null, `批量确认推荐 · ${easy.length} 题`));
    for (const q of easy) {
      const check = h('input', { type: 'checkbox', checked: selected.has(identity(q)), disabled: !canWrite() });
      check.onchange = () => { if (check.checked) selected.add(identity(q)); else selected.delete(identity(q)); };
      bulk.append(h('label', null, check, h('span', null, q.question, h('small', null, q.recommendedAnswer))));
    }
    bulk.append(button('查看所选完整答案并确认', openBulk, { disabled: !canWrite() || !easy.length }));
    const history = h('section', { class: 'desk-history', 'aria-label': '已答与历史' }, h('h2', null, '已答与历史'));
    for (const q of data.deskQuestions.filter(q => q.state !== 'pending')) {
      const row = h('article', { class: `desk-answer card-box ${q.state}` }, title(q), h('h3', null, q.state === 'withdrawn' ? h('s', null, q.question) : q.question),
        h('p', { class: 'desk-state' }, names[q.state]), q.withdrawnReason && h('p', null, `撤回原因：${q.withdrawnReason}`),
        q.currentAnswer && h('p', { class: 'desk-full-answer' }, choiceText(q.currentAnswer.choice)),
        live(q) && button('修改答复', () => chooseQuestion(q), { disabled: !key || busy }));
      if (q.answerHistory.length) row.append(h('details', null, h('summary', null, `答复记录 · ${q.answerHistory.length}`), q.answerHistory.map(a =>
        h('p', { class: 'desk-full-answer' }, `${a.stale ? '旧答复（已失效）' : '当前答复'}：${choiceText(a.choice)}`))));
      history.append(row);
    }
    const settled = h('section', { class: 'desk-settled', 'aria-label': '已结算决定' }, h('h2', null, '已结算决定'));
    for (const target of data.reopenTargets) settled.append(h('article', { class: 'desk-answer card-box' }, h('h3', null, `${target.ticketId} · ${target.title}`),
      h('p', { class: 'desk-full-answer' }, target.settlement.outcome.statement),
      button('请求重开', () => openReopen(target), { disabled: !canWrite() })));
    const requests = h('section', { class: 'desk-requests', 'aria-label': '重开请求' });
    if (data.reopenRequests.length) requests.append(h('h2', null, '重开请求'));
    for (const r of data.reopenRequests) requests.append(h('article', { class: 'desk-answer card-box' }, h('h3', null, r.ticketId),
      h('p', null, `${r.state === 'pending' ? '待取走 · 可以撤销' : '已取走 · 等待 agent 重开'}${r.stale ? ' · 原结算已变化' : ''}`),
      h('p', { class: 'desk-full-answer' }, choiceText(r.requested)), h('p', null, `授权的依赖题：${r.affectedTickets.join('、') || '无'}`),
      r.state === 'pending' && button('撤销重开请求', () => write({ action: 'cancelReopen', requestId: r.requestId }), { disabled: !canWrite() })));
    const count = qstate => data.deskQuestions.filter(q => q.state === qstate).length;
    content.replaceChildren(!key ? h('p', { class: 'notice card-box' }, '当前仅查看。请运行 ', h('code', null, `wayfinder desk ${mapId}`), ' 打开答题入口。') : '',
      h('div', { class: 'desk-summary' }, h('span', null, `待答 ${pending.length} · 已答 ${count('answered')} · 已取走 ${count('taken')} · 已结算 ${count('settled')}`),
        h('span', { class: 'desk-muted' }, data.quietUntil && Date.parse(data.quietUntil) > Date.now() ? `本轮最早可取走：${new Date(data.quietUntil).toLocaleTimeString()}` : '答复取走后仍需 agent 结算')),
      h('div', { class: 'desk-layout' }, queue, questionCard(current)), bulk, requests, history, settled);
    updateShortcutUI();
    // Polls can remove the focused button. Focus has no shortcut authority and
    // must not turn a queued Enter into an action on that vanished control.
    if (losesFocus && !dialog.open && !element.hidden && key) {
      (shortcutPause.hidden ? content.querySelector('.desk-question') : shortcutPause).focus({ preventScroll: true });
    }
  }
  const keydown = event => {
    if (element.hidden || dialog.open || event.target.closest('input,textarea,select,[contenteditable]')
      || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== 'Enter' && !/^[1-3t]$/i.test(event.key)) return;
    // Reserve shortcut keys even while paused: native Enter on a focused queue,
    // option or history control must never select/answer a different question.
    event.preventDefault();
    if (!active || armedQuestion !== active || !canWrite() || inactive || event.repeat) return;
    const q = data?.deskQuestions.find(q => identity(q) === active && live(q)); if (!q) return;
    const option = event.key === 'Enter' ? q.recommendedOption : /^[1-3]$/.test(event.key) ? Number(event.key) : null;
    if (option && q.options[option - 1]) { event.preventDefault(); submit(q, { option }); }
    else if (event.key.toLowerCase() === 't') { event.preventDefault(); openText(q); }
  };
  const windowBlur = () => {
    inactive = true; focusCheck++; pauseShortcuts();
  };
  const windowFocus = async () => {
    if (!inactive || document.hidden || destroyed) return;
    const check = ++focusCheck;
    // Hidden pages do not poll. Read first so an unseen replacement cannot be
    // armed for 600 ms using an obsolete local snapshot.
    try { await refresh(); } catch {
      if (check === focusCheck && !destroyed) { inactive = false; externalPause = true; pauseShortcuts(); }
      return;
    }
    if (check !== focusCheck || destroyed || document.hidden) return;
    inactive = false; armShortcuts(true);
  };
  const visibility = () => { if (document.hidden) windowBlur(); else windowFocus(); };
  document.addEventListener('keydown', keydown);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('focus', windowFocus);
  window.addEventListener('blur', windowBlur);
  return { element, destroy() {
    destroyed = true; focusCheck++; closeEditor(false); pauseShortcuts(); element.remove(); document.removeEventListener('keydown', keydown);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('focus', windowFocus); window.removeEventListener('blur', windowBlur);
  }, update(next, revision) {
    if (!next) return;
    // Polling must never silently move a pending keystroke onto a different publication.
    // Keep the interruption across subsequent polls, including when no pending question remains.
    if (active && !next.deskQuestions.some(q => identity(q) === active && live(q))) {
      changedQuestion = data.deskQuestions.find(q => identity(q) === active); active = null;
      externalPause = true; pauseShortcuts();
    }
    data = next; const nextFingerprint = JSON.stringify([revision, next]);
    if (fingerprint !== nextFingerprint) { fingerprint = nextFingerprint; render(); updateEditor(); }
  } };
}
