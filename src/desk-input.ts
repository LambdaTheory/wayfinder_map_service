import type { InvalidInput } from './types.js';
import { invalid, isPlainObject, validateArrayShape, validateId, validateObject } from './values.js';

type Path = readonly (string | number)[];
export function positiveVersion(value: unknown, path: Path): InvalidInput | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return invalid(path, 'Positive safe integer required');
}
export function validateDeskCommand(command: Record<string, unknown>, path: Path): InvalidInput | undefined {
  const closing = command.kind === 'reopenRequest.close';
  const posting = command.kind === 'deskQuestion.post';
  const shape = validateObject(command, path, closing ? ['kind', 'requestId', 'reason'] : posting
    ? ['kind', 'ticketId', 'claimantId', 'question'] : ['kind', 'ticketId', 'claimantId', 'questionId', 'questionVersion', 'reason']);
  if (shape) return shape;
  for (const key of closing ? ['requestId'] : posting ? ['ticketId', 'claimantId'] : ['ticketId', 'claimantId', 'questionId']) {
    const error = validateId(command[key], [...path, key]); if (error) return error;
  }
  if (!posting) {
    if (typeof command.reason !== 'string' || !command.reason.trim()) return invalid([...path, 'reason'], 'Nonblank reason required');
    return closing ? undefined : positiveVersion(command.questionVersion, [...path, 'questionVersion']);
  }
  const at = [...path, 'question']; const q = command.question;
  const qShape = validateObject(q, at, ['questionId', 'options', 'recommendedOption', 'recommendedAnswer', 'whyKun', 'triage', 'triageReason', 'gatesResearch']);
  if (qShape) return qShape;
  if (!isPlainObject(q)) return invalid(at, 'Plain question required');
  const identity = validateId(q.questionId, [...at, 'questionId']); if (identity) return identity;
  if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 3) return invalid([...at, 'options'], 'Two or three options required');
  const array = validateArrayShape(q.options, [...at, 'options']); if (array) return array;
  for (let i = 0; i < q.options.length; i++) {
    const option: unknown = q.options[i]; const op = [...at, 'options', i];
    const shape = validateObject(option, op, ['label', 'description']); if (shape) return shape;
    if (!isPlainObject(option)) return invalid(op, 'Plain option required');
    for (const key of ['label', 'description']) if (typeof option[key] !== 'string' || !option[key].trim()) return invalid([...op, key], 'Nonblank text required');
  }
  if (!Number.isInteger(q.recommendedOption) || (q.recommendedOption as number) < 1 || (q.recommendedOption as number) > q.options.length) return invalid([...at, 'recommendedOption'], 'Index of a displayed option required');
  for (const key of ['recommendedAnswer', 'whyKun', 'triageReason']) if (typeof q[key] !== 'string' || !q[key].trim()) return invalid([...at, key], 'Nonblank text required');
  if (q.triage !== 'needsKun' && q.triage !== 'followRecommendation') return invalid([...at, 'triage'], 'Supported triage required');
  if (typeof q.gatesResearch !== 'boolean') return invalid([...at, 'gatesResearch'], 'Boolean required');
}
export function validateDeskCitation(value: unknown, path: Path): InvalidInput | undefined {
  const shape = validateObject(value, path, ['answerId', 'questionVersion']); if (shape) return shape;
  if (!isPlainObject(value)) return invalid(path, 'Plain citation required');
  return validateId(value.answerId, [...path, 'answerId']) ?? positiveVersion(value.questionVersion, [...path, 'questionVersion']);
}
