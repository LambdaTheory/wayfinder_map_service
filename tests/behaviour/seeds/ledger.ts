// The bill-summary CLI planning Map (W6, W6b, S7) and its fixture repository `fixtures/ledger-cli`.
import type { SeedMap, SeedTicket } from '../scenario.ts';
import { decision, finding } from './common.ts';

export const L = {
  unit: { id: 'amount-unit', type: 'grilling', title: '金额存法', question: '金额怎么存和算？' },
  columns: { id: 'csv-columns', type: 'research', title: '导出文件的列', question: '银行导出的 CSV 有哪些列，编码是什么？' },
  dedupe: { id: 'dedupe', type: 'grilling', title: '重复账目', question: '同一笔账在两个导出文件里都出现时，怎么认定重复？' },
  nocat: { id: 'no-category', type: 'grilling', title: '无类别账目', question: '没有类别的账记到哪一类？' },
} satisfies Record<string, SeedTicket>;

const settledDecision = (statement: string, rationale: string) => decision(statement, rationale, '2026-10-24 与 Kun 的 grilling 会话');

export const settled = {
  unit: settledDecision('按分存整数，输出时换成元，保留两位。', 'Kun 不想处理浮点误差。'),
  columns: finding('列为 日期,摘要,金额,类别；支出为负数；UTF-8 带 BOM。', '2026-10-24 读取银行导出样例'),
  dedupe: settledDecision('日期、金额、摘要三项都相同算重复，只计一次。', 'Kun 认为银行流水里这三项相同即为同一笔。'),
  nocat: settledDecision('没有类别的账记到「未分类」。', 'Kun 想先看到全部支出，再补类别。'),
};

export function ledgerMap(tickets: SeedTicket[]): SeedMap {
  return { mapId: 'ledger-cli-plan-20261025', title: '账单汇总工具方案',
    destination: '得到一份可交给实现者的账单汇总命令行工具方案：输入格式、金额计算、分类规则和输出格式都已定下。',
    notes: '只做方案；实现由另开的会话完成。Node 26，不用第三方依赖。使用中文沟通。', tickets };
}

export const continueLedger = '继续 Wayfinder 地图「账单汇总工具方案」，地图 ID：ledger-cli-plan-20261025';
