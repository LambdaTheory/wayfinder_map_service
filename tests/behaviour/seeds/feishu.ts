// The Feishu-side planning Map used by most S and W Scenarios, from the 2026-10-22/24 stress experiment.
import type { SeedMap, SeedTicket } from '../scenario.ts';
import { decision } from './common.ts';

export const notes = '领域：飞书开放平台与既有 Agent 系统的对接。只规划飞书侧；Agent 系统另行设计。使用中文沟通。';
export const destination = '形成可交给开发实施的飞书侧接入方案：明确任务入口、任务记录载体、结果通知、应用权限和事件接入方式，以及分阶段搭建步骤与验收标准。既有 Agent 系统已能分发任务、执行并回传结果，不在本图设计。';
export const continueMap = '接着推进 Wayfinder 上飞书接入那张图。';

export const T = {
  scope: { id: 'first-scope', type: 'grilling', title: '首期使用范围', question: '首期飞书接入服务谁、覆盖哪一个完整的任务闭环？' },
  carrier: { id: 'task-carrier', type: 'grilling', title: '任务记录载体', question: '首期的任务记录用飞书任务还是多维表格承载？' },
  entry: { id: 'task-entry', type: 'grilling', title: '任务发起入口', question: '用户从飞书的什么入口发起任务？' },
  notice: { id: 'result-notice', type: 'grilling', title: '结果通知方式', question: '任务结果用什么飞书消息形式通知用户？' },
  limits: { id: 'api-limits', type: 'research', title: '消息与卡片接口限制核实', question: '飞书消息发送和卡片更新接口有哪些频率、时效和幂等限制？' },
  events: { id: 'event-ingress', type: 'research', title: '事件接收方式核实', question: '飞书长连接与 HTTP 回调在适用应用类型、部署要求和重试语义上有哪些差别？' },
  perm: { id: 'app-permissions', type: 'grilling', title: '应用权限范围', question: '飞书应用需要申请哪些接口权限、向哪些人开放？' },
  fields: { id: 'task-fields', type: 'grilling', title: '任务字段映射', question: '任务记录需要哪些字段，各字段从哪里来？' },
  dedupe: { id: 'agent-dedupe', type: 'grilling', title: 'Agent 防重复派发', question: 'Agent 系统如何保证同一任务不被重复派发和执行？' },
  retry: { id: 'agent-retry', type: 'grilling', title: 'Agent 执行重试', question: 'Agent 执行失败后如何重试与恢复？' },
} satisfies Record<string, SeedTicket>;

export const verdict = (statement: string, rationale: string) => decision(statement, rationale, '2026-10-22 与 Kun 的 grilling 会话');

export function feishuMap(tickets: SeedTicket[], extra: Partial<SeedMap> = {}): SeedMap {
  return { mapId: 'feishu-access-20261022', title: '飞书接入规划', destination, notes, tickets, ...extra };
}
