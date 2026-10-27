// Scripted human side of an owned Attempt. Uses the real browser boundary, never MCP answer authority.
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import type { EventRecord, WireDeskQuestion } from '../evidence.ts';
import type { Turn } from '../scenario.ts';
import { directAgent, directFetch } from './direct-http.ts';

export class DeskPrecondition extends Error {}

export async function prepareDeskTurn(port: number, keyPath: string, turn: Turn, index: number,
  observe: (event: EventRecord) => void): Promise<string> {
  if (!turn.desk) return turn.say;
  const plan = turn.desk;
  const origin = `http://127.0.0.1:${port}`;
  const agent = directAgent();
  const record = (action: string, detail: unknown) => observe({ seq: 0, at: new Date().toISOString(),
    actor: 'script-human', session: turn.session, turn: index, kind: 'controller', action, detail });
  const request = async (path: string, input?: unknown) => {
    const endpoint = new URL(path, origin);
    const response = await directFetch(endpoint, agent)(endpoint, {
      signal: AbortSignal.timeout(10_000), ...(input === undefined ? {} : { method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-wayfinder-key': readFileSync(keyPath, 'utf8') }, body: JSON.stringify(input) }),
    });
    if (!response.ok) throw new DeskPrecondition(`Desk request refused (${response.status})`);
    return await response.json() as { desk?: { deskQuestions: WireDeskQuestion[]; quietUntil?: string | null }; kind?: string };
  };
  try {
    const viewPath = `/api/maps/${encodeURIComponent(plan.mapId)}/view`;
    const view = await request(viewPath);
    const pending = view.desk?.deskQuestions.filter(q => q.state === 'pending') ?? [];
    if (!plan.ticketIds.every(id => pending.some(q => q.ticketId === id)))
      throw new DeskPrecondition('Required Pending desk questions were not displayed');
    // Keep exact question/version and options as evidence of what the scripted human saw.
    record('desk-observed', { mapId: plan.mapId, questions: pending });
    if (plan.conversationRecommendation) {
      const q = pending.find(q => q.ticketId === plan.conversationRecommendation)!;
      const option = q.options[q.recommendedOption - 1];
      if (!option) throw new DeskPrecondition('Displayed recommendation is missing');
      return `关于答题台上的「${q.question}」（Ticket ${q.ticketId}，问题 ${q.questionId} 第 ${q.questionVersion} 版），我明确选择第 ${q.recommendedOption} 项「${option.label}」：${option.description}。请按这个具体答案结算。${turn.say}`;
    }
    for (const reply of plan.submit ?? []) {
      const q = pending.find(q => q.ticketId === reply.ticketId)!;
      const choice = reply.choice === 'recommendation' ? { option: q.recommendedOption } : reply.choice;
      const submission = { questionId: q.questionId, questionVersion: q.questionVersion, choice };
      // One click per question: needsKun may never be slipped into the bulk followRecommendation action.
      const result = await request('/api/desk', { action: 'answer', mapId: plan.mapId, submissions: [submission] });
      if (result.kind !== 'updated') throw new DeskPrecondition('Desk answer was not accepted');
      record('desk-answer', { mapId: plan.mapId, ticketId: q.ticketId, submission, result });
    }
    if (plan.submit?.length) {
      // The next turn may use a taking read (ChatGPT); let the real Quiet Window elapse first.
      const quiet = (await request(viewPath)).desk?.quietUntil;
      const ms = quiet ? Date.parse(quiet) - Date.now() : 0;
      if (!Number.isFinite(ms) || ms > 16_000) throw new DeskPrecondition('Unexpected Quiet Window');
      if (ms > 0) await setTimeout(ms + 1);
    }
    return turn.say;
  } finally { agent.destroy(); }
}
