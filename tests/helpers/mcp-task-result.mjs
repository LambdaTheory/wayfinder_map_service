import { CallToolResultV2Schema, GetTaskResultV2Schema } from '@modelcontextprotocol/ext-tasks/core/v2';

// Use the released 0.2.2 runtime schemas exactly as its requester does. Its
// generated declarations fail strict optional/index-signature checking, so keep
// this runtime-only test adapter behind a narrow declaration, not skipLibCheck.
export function completedTaskContent(value) {
  const task = GetTaskResultV2Schema.parse(value);
  if (task.status !== 'completed') throw Error('Expected a completed task');
  const result = CallToolResultV2Schema.parse(task.result);
  if (result.resultType !== 'complete' || !result.structuredContent
    || typeof result.structuredContent !== 'object' || Array.isArray(result.structuredContent)) {
    throw Error('Expected complete structured tool content');
  }
  return result.structuredContent;
}
