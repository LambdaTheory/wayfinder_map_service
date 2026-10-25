// Generates the two bank exports in fixtures/ledger-cli/samples/ for S7, and the facts a correct spike finds.
// The facts stay here, outside the fixture the agent can read. `library.test.ts` checks the committed files match.

const summaries: [string, string, number][] = [
  ['美团外卖', '餐饮', 3500], ['瑞幸咖啡', '餐饮', 1600], ['食堂午餐', '餐饮', 1800], ['盒马鲜生', '日用', 8900],
  ['滴滴出行', '交通', 2300], ['京东购物', '购物', 12900], ['淘宝购物', '购物', 6900], ['电影票', '娱乐', 4500],
  ['便利店', '', 1250], ['药店', '', 3600], ['话费充值', '日用', 5000], ['健身房', '娱乐', 9900],
];

export interface Row { date: string; summary: string; amount: number; category: string }

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

const day = (d: number) => `2026-09-${String(d).padStart(2, '0')}`;

/** One account's September activity; both exports are cut from it, with overlapping date ranges. */
function activity(): Row[] {
  const rand = lcg(20261025);
  const rows: Row[] = [];
  for (let d = 1; d <= 30; d++) {
    const n = 8 + Math.floor(rand() * 4);
    for (let i = 0; i < n; i++) {
      const [summary, category, base] = summaries[Math.floor(rand() * summaries.length)]!;
      const cents = base + Math.floor(rand() * 40) * 10;
      rows.push({ date: day(d), summary, amount: -cents, category });
    }
    // Two separate subway rides on the same day: identical rows that are not duplicates.
    if ([3, 6, 9, 12, 17, 19, 23, 26, 29].includes(d)) rows.push({ date: day(d), summary: '地铁出行', amount: -400, category: '交通' },
      { date: day(d), summary: '地铁出行', amount: -400, category: '交通' });
    if (d === 10 || d === 25) rows.push({ date: day(d), summary: '工资', amount: 1500000, category: '收入' });
  }
  return rows;
}

const aRange = [1, 20];
const bRange = [15, 30];
/** Overlap rows whose summary the later export extends with an order number (by index within the overlap). */
const renamed = [2, 9, 17, 23, 31, 40, 52];

export function exports() {
  const all = activity();
  const inRange = (r: Row, [from, to]: number[]) => { const d = Number(r.date.slice(8)); return d >= from! && d <= to!; };
  const a = all.filter(r => inRange(r, aRange));
  const overlap = all.filter(r => inRange(r, [bRange[0]!, aRange[1]!]));
  const b = all.filter(r => inRange(r, bRange)).map(r => {
    const i = overlap.indexOf(r);
    return renamed.includes(i) ? { ...r, summary: `${r.summary} 订单尾号${String(1000 + i * 37).slice(-4)}` } : r;
  });
  return { a, b, overlap };
}

export function csv(rows: Row[]): string {
  return '﻿日期,摘要,金额,类别\n' + rows.map(r => `${r.date},${r.summary},${(r.amount / 100).toFixed(2)},${r.category}`).join('\n') + '\n';
}

/** What a correct spike over the two files finds about the rule 「日期、金额、摘要三项都相同算重复，只计一次」. */
export function facts() {
  const { a, b, overlap } = exports();
  const key = (r: Row) => `${r.date}|${r.amount}|${r.summary}`;
  const count = (rows: Row[]) => rows.reduce((m, r) => m.set(key(r), (m.get(key(r)) ?? 0) + 1), new Map<string, number>());
  const ca = count(a); const cb = count(b);
  let crossExact = 0;
  for (const [k, n] of ca) crossExact += Math.min(n, cb.get(k) ?? 0);
  const withinA = [...ca.values()].filter(n => n > 1).reduce((s, n) => s + n - 1, 0);
  const withinB = [...cb.values()].filter(n => n > 1).reduce((s, n) => s + n - 1, 0);
  const distinct = new Set([...a, ...b].map(key)).size;
  return {
    rowsA: a.length, rowsB: b.length, overlapRows: overlap.length,
    /** Rows of the overlap that appear in both files byte for byte. */
    crossExact,
    /** Overlap rows the later export renamed: real duplicates the rule misses. */
    missedNearDuplicates: renamed.length,
    /** Identical rows inside one file (separate subway rides) that "count once" would wrongly merge. */
    sameFileRepeatsA: withinA, sameFileRepeatsB: withinB,
    /** Rows left if every identical (date, amount, summary) counts once across both files. */
    distinctUnderRule: distinct,
    /** Rows of the account's real activity in September. */
    realRows: activity().length,
  };
}
