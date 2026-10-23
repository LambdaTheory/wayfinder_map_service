// Read-only Wayfinder Map viewer. It only reads /api/*; Map changes happen in the agent through MCP.
// The page CSP forbids inline styles, so elements are built here and positioned through CSSOM.
(() => {
  'use strict';
  const POLL_MS = 2000;
  const $ = id => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const px = value => `${Math.round(value)}px`;

  function append(element, children) {
    for (const child of children.flat(Infinity)) {
      if (child !== null && child !== undefined && child !== false) element.append(child instanceof Node ? child : String(child));
    }
    return element;
  }
  function h(tag, props, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') element.className = value;
      else if (key === 'style') Object.assign(element.style, value);
      else if (key === 'dataset') Object.assign(element.dataset, value);
      else element.setAttribute(key, value === true ? '' : String(value));
    }
    return append(element, children);
  }
  const fill = (element, children) => { element.replaceChildren(); return append(element, [children]); };
  function svg(tag, attributes, ...children) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes ?? {})) if (value !== undefined && value !== null) element.setAttribute(key, String(value));
    return append(element, children);
  }

  const TYPE = { grilling: '追问', prototype: '原型', research: '调研', task: '任务' };
  const STATE = { settled: ['done', '已定'], inProgress: ['work', '进行中'], available: ['open', '可以开始'], waiting: ['wait', '等前置'] };
  const OUTCOME = { decision: '决定', finding: '发现', completion: '完成' };
  const pad = n => String(n).padStart(2, '0');
  const fmt = iso => { const d = new Date(iso); return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const clock = d => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const stamp = s => `修订 ${s.revision} · ${fmt(s.occurredAt)} · ${s.clientId}`;
  const stateMark = state => h('span', { class: `st ${STATE[state][0]}` }, STATE[state][1]);
  const typeMark = type => h('span', { class: 'ty' }, TYPE[type] ?? type);
  const newTag = () => h('span', { class: 'newtag' }, '刚改');
  // Stable IDs are what agents use in tool calls; showing them lets the human name a node.
  const idTag = id => h('code', { class: 'tid', title: id }, id);

  const route = /^\/maps\/([^/]+)$/.exec(location.pathname);
  let mapId = null;
  if (route) { try { mapId = decodeURIComponent(route[1]); } catch { mapId = route[1]; } }

  let view = null;          // the MapView on screen
  let missing = false;
  let selected = null;      // 'dest', 'fog:<id>' or 'ticket:<id>'; Ticket IDs may contain ':'
  let lastContact = null;
  let listKey = null;
  let timer = 0, pulseTimer = 0, inFlight = false;
  const histories = new Map();

  // Following: ask every two seconds whether a newer Revision exists.
  async function poll() {
    clearTimeout(timer);
    if (inFlight) return;
    if (!document.hidden) {
      inFlight = true;
      try {
        await (mapId === null ? pollList() : pollMap());
        lastContact = new Date();
        setConnected(true);
      } catch { setConnected(false); }
      finally { inFlight = false; }
    }
    timer = setTimeout(poll, POLL_MS);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

  async function pollMap() {
    const response = await fetch(`/api/maps/${encodeURIComponent(mapId)}/view?known=${view ? view.revision : 0}`,
      { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (response.status === 204) return;
    if (response.status === 404 || response.status === 400) {
      if (!missing) { missing = true; view = null; renderMissing(); }
      return;
    }
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    const next = await response.json();
    const previous = view;
    view = next;
    missing = false;
    // If drawing fails, keep asking for this Revision rather than calling a half-drawn page current.
    try { renderMap(previous && previous.revision !== next.revision ? previous : null); }
    catch (error) { view = previous; throw error; }
  }

  async function pollList() {
    const response = await fetch('/api/maps', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    const { maps } = await response.json();
    const key = JSON.stringify(maps);
    if (key !== listKey) { listKey = key; renderList(maps); }
  }

  function setConnected(up) {
    $('conn').className = `conn ${up ? 'up' : 'down'}`;
    $('connText').textContent = up ? (mapId === null ? '已连接' : '已连接 · 跟着地图更新') : '连不上 · 正在重试';
    document.body.classList.toggle('down', !up);
    $('stale').hidden = up;
    if (up) return;
    // Never present the last observed state as current.
    $('stale').textContent = !lastContact ? '连不上地图服务，正在重试。'
      : view ? `连不上地图服务。下面是修订 ${view.revision}（${fmt(view.occurredAt)} 写入）时的地图，最后一次连上是 ${clock(lastContact)}，可能已经过时。`
        : `连不上地图服务。下面是 ${clock(lastContact)} 时看到的内容，可能已经过时。`;
  }

  function renderList(maps) {
    document.title = 'Wayfinder 地图';
    $('title').textContent = '全部地图';
    $('rev').textContent = `${maps.length} 张`;
    $('main').replaceChildren(maps.length
      ? h('ul', { class: 'maps' }, maps.map(map => h('li', null, h('a', { class: 'card-box', href: `/maps/${map.mapId}` },
        h('div', { class: 't' }, map.title), h('div', { class: 'd' }, map.destination), h('div', { class: 'i' }, `${map.mapId} · 修订 ${map.currentRevision}`)))))
      : h('p', { class: 'notice card-box' }, '还没有地图。在 Agent 里建一张，这里会出现。'));
  }

  // Another site may link any address here; only a well-formed Map ID is echoed.
  function renderMissing() {
    const wellFormed = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(mapId);
    document.title = 'Wayfinder 地图';
    $('title').textContent = wellFormed ? mapId : '地址不对';
    $('rev').textContent = '';
    selected = null;
    renderDetail();
    $('main').replaceChildren(h('p', { class: 'notice card-box' }, wellFormed ? ['没有这张地图：', h('code', null, mapId), '。'] : '这个地址不是一张地图。',
      h('a', { href: '/' }, '看全部地图'), '。'));
  }

  // previous is set only when a newer Revision arrived while following; it drives the animations.
  function renderMap(previous) {
    if (!view) return;
    document.title = `${view.title} · Wayfinder`;
    $('title').textContent = view.title;
    $('rev').replaceChildren(idTag(view.mapId), ' ', h('b', null, `修订 ${view.revision}`), ` · ${fmt(view.occurredAt)} · ${view.clientId} 写入`);
    // A new drawing must not move the reader: keep the map's and the page's scroll position.
    const oldGraph = $('main').querySelector('.graph');
    const kept = oldGraph ? { left: oldGraph.scrollLeft, top: oldGraph.scrollTop } : null;
    const pageY = scrollY;
    $('main').replaceChildren(
      h('div', { class: 'change' }, h('span', { class: 'k' }, `修订 ${view.revision} 改了`), h('span', null, summary(view.latest))),
      h('div', { class: 'mapbox card-box' }, graph(previous)),
      h('div', { class: 'below' }, outside(), legend()));
    const newGraph = $('main').querySelector('.graph');
    if (kept && newGraph) { newGraph.scrollLeft = kept.left; newGraph.scrollTop = kept.top; }
    if (scrollY !== pageY) scrollTo(scrollX, pageY);
    renderDetail();
    clearTimeout(pulseTimer);
    if (previous) pulseTimer = setTimeout(() => renderMap(null), 1800);
  }

  function summary(latest) {
    const counts = new Map(), parts = [];
    const count = key => counts.set(key, (counts.get(key) ?? 0) + 1);
    const named = (verb, change) => parts.push(change.label ? `${verb} ${change.subjectId}「${change.label}」` : `${verb} ${change.subjectId}`);
    for (const change of latest) {
      switch (change.kind) {
        case 'map.create': parts.push('建了这张地图，定下目的地'); break;
        case 'destination.update': parts.push('改了目的地'); break;
        case 'map.update': parts.push('改了地图标题或说明'); break;
        case 'ticket.create': count('新增问题 # 个'); break;
        case 'ticket.update': named('改了', change); break;
        case 'ticket.settle': named('定下', change); break;
        case 'ticket.reopen': named('重新打开', change); break;
        case 'claim.acquire': named('开始', change); break;
        case 'claim.release': case 'claim.clear': named('放下', change); break;
        case 'dependency.add': count('加了依赖 # 条'); break;
        case 'dependency.remove': count('去掉依赖 # 条'); break;
        case 'fog.add': count('新起迷雾 # 处'); break;
        case 'fog.update': count('迷雾变了 # 处'); break;
        case 'fog.remove': count('迷雾散去 # 处'); break;
        case 'scope.add': count('划出范围外 # 条'); break;
        case 'scope.update': count('改了范围外 # 条'); break;
        case 'scope.remove': count('收回范围外 # 条'); break;
        default: count('其他改动 # 处');
      }
    }
    for (const [key, value] of counts) parts.push(key.replace('#', value));
    return [...new Set(parts)].join(' · ');
  }

  // Stable pseudo-random cloud blobs, so Fog keeps its shape between renders.
  function blobs(x, y, w, h, n, seed) {
    let state = seed * 9301 + 49297;
    const random = () => (state = (state * 9301 + 49297) % 233280) / 233280;
    return Array.from({ length: n }, () => svg('ellipse', { cx: x + 40 + random() * Math.max(0, w - 80), cy: y + 20 + random() * Math.max(0, h - 40),
      rx: 45 + random() * 30, ry: 30 + random() * 30, opacity: (0.6 + random() * 0.3).toFixed(2) }));
  }
  const flag = () => svg('svg', { viewBox: '0 0 14 16', 'aria-hidden': 'true' },
    svg('line', { x1: 2, y1: 1, x2: 2, y2: 15 }), svg('path', { d: 'M2.8,1.5 H12 L9.5,4.5 L12,7.5 H2.8 Z' }));
  const marker = (id, on) => svg('marker', { id, class: on ? 'arrow on' : 'arrow', viewBox: '0 0 10 10', refX: 1, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto' },
    svg('path', { d: 'M0,0 L10,5 L0,10 z' }));

  function graph(previous) {
    const tickets = view.tickets;
    const byId = new Map(tickets.map(ticket => [ticket.id, ticket]));
    const narrow = innerWidth < 760;
    const layers = [...new Set(tickets.map(ticket => ticket.layer))].sort((a, b) => a - b);
    const cols = layers.map(layer => tickets.filter(ticket => ticket.layer === layer).sort((a, b) => a.row - b.row));
    const changed = new Set(view.latest.filter(change => /^(ticket|claim|dependency)\./.test(change.kind)).map(change => change.subjectId));
    const changedFog = new Set(view.latest.filter(change => change.kind === 'fog.add' || change.kind === 'fog.update').map(change => change.subjectId));
    const destinationChanged = view.latest.some(change => change.kind === 'map.create' || change.kind === 'destination.update');
    // Fog cleared by this Revision is drawn once more and fades out.
    const removed = previous ? previous.fog.filter(item => !view.fog.some(other => other.id === item.id)) : [];
    const added = new Set(previous ? view.fog.filter(item => !previous.fog.some(other => other.id === item.id)).map(item => item.id) : []);
    const fogs = [...view.fog.map(item => ({ ...item, out: false })), ...removed.map(item => ({ ...item, out: true }))];

    const W = narrow ? Math.min(160, (innerWidth - 90) / 2) : 184, H = narrow ? 150 : 128, GX = narrow ? 14 : 46, GY = narrow ? 40 : 16, TOP = 30;
    const DW = narrow ? Math.min(2 * W + GX, 300) : 210, DH = 124, CH = 80, BLANK = narrow ? 48 : 240;
    const maxN = Math.max(1, ...cols.map(col => col.length));
    const routeW = cols.length ? (narrow ? maxN * (W + GX) - GX : cols.length * (W + GX) - GX) : 0;
    const routeH = cols.length ? (narrow ? cols.length * (H + GY) - GY : maxN * (H + GY) - GY) : 0;
    const zoneH = fogs.length * CH + DH;
    let width, height, zx, zy, ox = 0, oy = 0;
    if (narrow) {
      width = Math.max(routeW, DW); zx = (width - DW) / 2; zy = TOP + (cols.length ? routeH + GY : BLANK);
      height = zy + zoneH; ox = (width - routeW) / 2;
    } else {
      zx = cols.length ? routeW + GX + 24 : BLANK; width = zx + DW; height = TOP + Math.max(routeH, zoneH) + 16;
      zy = TOP + (height - 16 - TOP - zoneH) / 2; oy = (height - 16 - TOP - routeH) / 2;
    }
    const pos = new Map();
    cols.forEach((col, l) => col.forEach((ticket, i) => {
      const offset = (maxN - col.length) / 2;
      pos.set(ticket.id, narrow ? { x: ox + (i + offset) * (W + GX), y: TOP + l * (H + GY), w: W, h: H }
        : { x: l * (W + GX), y: TOP + oy + (i + offset) * (H + GY), w: W, h: H });
    }));
    const dest = { x: zx, y: zy + fogs.length * CH, w: DW, h: DH };

    // Layers run along the main axis: x when wide, y when narrow. An edge that skips a layer
    // leaves through the gap and runs in a lane beside the cards of the layers it passes.
    const P = (main, cross) => narrow ? `${cross},${main}` : `${main},${cross}`;
    const mainStart = box => narrow ? box.y : box.x, mainEnd = box => narrow ? box.y + box.h : box.x + box.w;
    const crossStart = box => narrow ? box.x : box.y, crossEnd = box => narrow ? box.x + box.w : box.y + box.h;
    const crossMid = box => (crossStart(box) + crossEnd(box)) / 2;
    const gap = narrow ? GY : GX;
    const lanes = { before: 0, after: 0 };
    const edgePath = (a, from, b, to) => {
      const m1 = mainEnd(a), c1 = crossMid(a), m2 = mainStart(b), c2 = crossMid(b);
      const passed = cols.slice(from + 1, to).flat().map(ticket => pos.get(ticket.id));
      if (!passed.length) {
        const mm = (m1 + m2) / 2;
        return `M${P(m1, c1)} C${P(mm, c1)} ${P(mm, c2)} ${P(m2 - 6, c2)}`;
      }
      const low = Math.min(...passed.map(crossStart)), high = Math.max(...passed.map(crossEnd));
      const side = (c1 + c2) / 2 < (low + high) / 2 ? 'before' : 'after';
      const lane = side === 'before' ? low - 10 - 6 * lanes.before++ : high + 10 + 6 * lanes.after++;
      return `M${P(m1, c1)} C${P(m1 + gap / 2, c1)} ${P(m1 + gap / 2, lane)} ${P(m1 + gap, lane)} L${P(m2 - gap, lane)} `
        + `C${P(m2 - gap / 2, lane)} ${P(m2 - gap / 2, c2)} ${P(m2 - 6, c2)}`;
    };
    const layerOf = new Map(cols.flatMap((col, index) => col.map(ticket => [ticket.id, index])));
    const edges = [];
    for (const ticket of tickets) {
      for (const prerequisite of ticket.prerequisites) {
        if (pos.has(prerequisite)) edges.push({ d: edgePath(pos.get(prerequisite), layerOf.get(prerequisite), pos.get(ticket.id), layerOf.get(ticket.id)),
          ends: [`ticket:${prerequisite}`, `ticket:${ticket.id}`], cls: '' });
      }
      // The route ends at the Destination: Tickets nothing else depends on lead there.
      if (ticket.dependents.length === 0) edges.push({ d: edgePath(pos.get(ticket.id), layerOf.get(ticket.id), dest, cols.length), ends: [`ticket:${ticket.id}`, 'dest'],
        cls: ` todest${ticket.state === 'settled' && view.fog.length === 0 ? ' clear' : ''}` });
    }
    const lines = svg('svg', { width, height, 'aria-hidden': 'true' }, svg('defs', null, marker('arr', false), marker('arrOn', true)),
      edges.map(edge => {
        const on = edge.ends.includes(selected);
        return svg('path', { class: `edge${edge.cls}${on ? ' on' : ''}`, d: edge.d, 'data-ends': edge.ends.join(' '), 'marker-end': `url(#${on ? 'arrOn' : 'arr'})` });
      }));

    const heads = narrow || !cols.length ? [] : [...cols.map((_, x) => h('span', { class: 'colh', style: { left: px(x * (W + GX)) } }, x === 0 ? '不依赖别的' : `第 ${x + 1} 层`)),
      h('span', { class: 'colh', style: { left: px(zx) } }, view.fog.length ? '迷雾和目的地' : '目的地')];
    const blank = cols.length ? null : h('span', { class: 'blank', style: narrow ? { left: '0px', top: px(TOP), width: px(width) } : { left: '0px', top: px(dest.y + 20), width: px(BLANK - 30) } },
      '还没有问题。Agent 定下第一批问题后，路线画在这里。');

    const cards = tickets.map(ticket => {
      const pending = ticket.prerequisites.filter(id => byId.get(id)?.state !== 'settled').map(id => byId.get(id)?.title ?? id);
      const line = ticket.state === 'settled' ? ticket.settlement?.outcome.statement : ticket.state === 'waiting' ? `等：${pending.join('、')}`
        : ticket.state === 'inProgress' ? `${ticket.claimantId} 正在处理` : ticket.question;
      const box = pos.get(ticket.id), isNew = changed.has(ticket.id);
      return h('button', { type: 'button', class: `tk ${STATE[ticket.state][0]}${isNew ? ` new${previous ? ' pulse' : ''}` : ''}${selected === `ticket:${ticket.id}` ? ' sel' : ''}`,
        dataset: { id: `ticket:${ticket.id}` }, style: { left: px(box.x), top: px(box.y), width: px(box.w), height: px(box.h) } },
      // The orange outline marks a just-changed card; its meta row keeps state, type and ID on one line.
      h('span', { class: 'm' }, stateMark(ticket.state), typeMark(ticket.type), idTag(ticket.id)),
      h('span', { class: 't' }, ticket.title), h('span', { class: 's' }, line ?? ''));
    });

    const open = tickets.filter(ticket => ticket.state !== 'settled').length;
    const foot = view.fog.length ? `还隔着 ${view.fog.length} 处迷雾` : view.routeClear ? '路线通到这里了' : tickets.length ? `前面还有 ${open} 个问题没定` : '路线还没画';
    const destination = h('button', { type: 'button', class: `dest${view.fog.length ? ' fogged' : ''}${view.routeClear ? ' clear' : ''}${selected === 'dest' ? ' sel' : ''}${destinationChanged ? ' new' : ''}`,
      dataset: { id: 'dest' }, style: { left: px(dest.x), top: px(dest.y), width: px(dest.w), height: px(dest.h) } },
    h('span', { class: 'h' }, flag(), '目的地', destinationChanged ? newTag() : null), h('span', { class: 'd' }, view.destination), h('span', { class: 'f' }, foot));

    // Fog covers the stretch in front of the Destination; each item thickens it.
    const fogHeight = zoneH * 0.8;
    const fogLayer = fogs.length ? svg('svg', { class: 'foglayer', width, height, 'aria-hidden': 'true' },
      svg('defs', null, svg('filter', { id: 'fb', x: '-40%', y: '-40%', width: '180%', height: '180%' }, svg('feGaussianBlur', { stdDeviation: 16 }))),
      svg('g', { filter: 'url(#fb)', class: view.fog.length ? (previous && !previous.fog.length ? 'fog-in' : '') : 'fog-out' }, blobs(zx, zy, DW, fogHeight, 5, 7)),
      fogs.map((item, i) => svg('g', { filter: 'url(#fb)', class: item.out ? 'fog-out' : added.has(item.id) ? 'fog-in' : '' },
        blobs(zx, zy + i * CH - 10, DW, CH + 20, 4, 11 + i)))) : null;
    const fogTexts = fogs.map((item, i) => h('button', { type: 'button', class: `fogtxt${item.out ? ' fog-out' : added.has(item.id) ? ' fog-in' : ''}${selected === `fog:${item.id}` ? ' sel' : ''}`,
      dataset: { id: `fog:${item.id}` }, style: { left: px(zx), top: px(zy + i * CH), width: px(DW), height: px(CH - 6) } },
    h('b', null, '迷雾', changedFog.has(item.id) ? newTag() : null, idTag(item.id)), h('span', { class: 'x' }, item.text)));

    return h('div', { class: 'graph' }, h('div', { class: 'gcanvas', style: { width: px(width), height: px(height) } },
      lines, heads, blank, cards, destination, fogLayer, fogTexts));
  }

  function outside() {
    const changed = new Set(view.latest.filter(change => change.kind.startsWith('scope.')).map(change => change.subjectId));
    return h('section', { class: 'outside' }, h('h2', null, '地图之外 · 明确不做的'), view.scopeExclusions.length
      ? h('ul', null, view.scopeExclusions.map(item => h('li', null, idTag(item.id), ' ', item.text, changed.has(item.id) ? [' ', newTag()] : null)))
      : h('span', null, '没有'));
  }

  function legend() {
    return h('div', { class: 'legend' }, Object.keys(STATE).map(stateMark),
      h('span', null, h('i', { class: 'sw destsw' }), '目的地'), h('span', null, h('i', { class: 'sw fogsw' }), '迷雾'),
      h('span', null, h('i', { class: 'sw newsw' }), '这次修订刚改的'));
  }

  function renderDetail() {
    const content = !view || !selected ? null : selected === 'dest' ? destinationDetail()
      : selected.startsWith('fog:') ? fogDetail(selected.slice('fog:'.length))
        : selected.startsWith('ticket:') ? ticketDetail(selected.slice('ticket:'.length)) : null;
    if (!content) selected = null;
    $('side').hidden = !content;
    document.body.classList.toggle('drawer-open', !!content);
    fill($('detail'), content);
  }

  // Revision history is read only when a details panel asks for it.
  function lazy(subject, draw) {
    const slot = h('div', null, h('p', { class: 'hint' }, '正在读修订历史…'));
    const key = `${subject}@${view.revision}`;
    let pending = histories.get(key);
    if (!pending) {
      pending = fetch(`/api/maps/${encodeURIComponent(mapId)}/history?subject=${encodeURIComponent(subject)}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
        .then(response => { if (response.status !== 200) throw new Error(`HTTP ${response.status}`); return response.json(); });
      pending.catch(() => histories.delete(key));
      histories.set(key, pending);
    }
    pending.then(data => fill(slot, draw(data)), () => fill(slot, h('p', { class: 'hint' }, '读不到修订历史。')));
    return slot;
  }

  function destinationDetail() {
    const settled = view.tickets.filter(ticket => ticket.state === 'settled').length;
    return [h('h2', null, '目的地'), h('p', null, view.destination),
      lazy('destination', data => [h('h3', null, '建图时定下'), h('p', null, stamp(data.created)), h('h3', null, '之后改过'),
        data.changes.length ? h('ul', null, data.changes.map(change => h('li', null, `${stamp(change)}：`, change.destination))) : h('p', { class: 'hint' }, '没改过。')]),
      h('h3', null, '离它还有多远'), h('p', null, `${settled} / ${view.tickets.length} 个问题已定，迷雾 ${view.fog.length} 处。`)];
  }

  function fogDetail(fogId) {
    const item = view.fog.find(candidate => candidate.id === fogId);
    if (!item) return [h('h2', null, '迷雾'), h('p', { class: 'hint' }, '这片迷雾已经散了。')];
    return [h('div', { class: 'm' }, idTag(item.id)), h('h2', null, '迷雾'), h('p', null, item.text), referenceList('来源', item.references),
      lazy(`fog:${fogId}`, data => [h('h3', null, '出现于'), h('p', null, data.appearedAt ? stamp(data.appearedAt) : '—')]),
      h('p', { class: 'hint' }, '在范围内，但还提不成问题。前面的问题定下后，它会变成新问题，或者直接散去。')];
  }

  function ticketDetail(ticketId) {
    const byId = new Map(view.tickets.map(ticket => [ticket.id, ticket]));
    const ticket = byId.get(ticketId);
    if (!ticket) return null;
    const link = id => h('li', null, idTag(id), ' ', h('button', { type: 'button', class: 'lnk', dataset: { id: `ticket:${id}` } }, byId.get(id)?.title ?? id), ' ', byId.has(id) ? stateMark(byId.get(id).state) : null);
    const out = [h('div', { class: 'm' }, stateMark(ticket.state), typeMark(ticket.type), idTag(ticket.id)), h('h2', null, ticket.title), h('h3', null, '问题'), h('p', null, ticket.question)];
    if (ticket.state === 'inProgress') out.push(h('h3', null, '谁在处理'), h('p', null, ticket.claimantId));
    if (ticket.prerequisites.length) out.push(h('h3', null, '前置'), h('ul', null, ticket.prerequisites.map(link)));
    if (ticket.dependents.length) out.push(h('h3', null, '它定下后才能开始'), h('ul', null, ticket.dependents.map(link)));
    else out.push(h('h3', null, '它定下后'), h('p', null, '直接通往', h('button', { type: 'button', class: 'lnk', dataset: { id: 'dest' } }, '目的地'), '。'));
    if (ticket.settlement) out.push(settlementDetail(ticket.settlement));
    return out;
  }

  function settlementDetail(settlement) {
    const outcome = settlement.outcome;
    const facts = Object.entries(outcome.resultingFacts ?? {});
    return [h('h3', null, `结论 · ${OUTCOME[outcome.kind] ?? outcome.kind} · 修订 ${settlement.introducedAtRevision} 定下`), h('p', null, outcome.statement),
      outcome.rationale ? [h('h3', null, '理由'), h('p', null, outcome.rationale)] : null,
      outcome.limitations ? [h('h3', null, '局限'), h('p', null, outcome.limitations)] : null,
      facts.length ? [h('h3', null, '结果'), h('ul', null, facts.map(([key, value]) => h('li', null, h('code', null, key), '：', typeof value === 'string' ? value : JSON.stringify(value))))] : null,
      settlement.evidence.length ? [h('h3', null, '证据'), h('ul', null, settlement.evidence.map(evidence => h('li', null, evidence.statement,
        evidence.references.length ? h('div', { class: 'ref' }, '来源：', joined(evidence.references.map(reference))) : null)))] : null,
      referenceList('来源', settlement.references),
      [h('h3', null, '怎么得出的'), h('p', null, settlement.provenance.method), referenceList(null, settlement.provenance.sources)]];
  }

  function referenceList(title, references) {
    if (!references.length) return null;
    return [title ? h('h3', null, title) : null, h('ul', null, references.map(item => h('li', null, reference(item))))];
  }
  function reference(item) {
    const text = item.label && item.label.trim() ? item.label : item.locator;
    return /^https?:\/\//i.test(item.locator) ? h('a', { href: item.locator, target: '_blank', rel: 'noopener noreferrer' }, text) : h('span', { title: item.locator }, text);
  }
  const joined = items => items.flatMap((item, i) => i ? ['、', item] : [item]);

  // Selecting only restyles the drawing; rebuilding it would reset scrolling and running animations.
  function select(key) {
    selected = key;
    for (const element of $('main').querySelectorAll('.tk, .dest, .fogtxt')) element.classList.toggle('sel', element.dataset.id === selected);
    for (const edge of $('main').querySelectorAll('path.edge')) {
      const on = edge.dataset.ends.split(' ').includes(selected);
      edge.classList.toggle('on', on);
      edge.setAttribute('marker-end', `url(#${on ? 'arrOn' : 'arr'})`);
    }
    renderDetail();
    // Scroll only if the selected element is not fully visible.
    if (selected) $('main').querySelector(`[data-id="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-id]');
    if (target && view) select(target.dataset.id);
  });
  $('close').addEventListener('click', () => select(null));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && selected) select(null); });
  let resizeTimer = 0;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => renderMap(null), 150); });
  poll();
})();
