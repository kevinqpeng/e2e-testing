import { createHash } from 'node:crypto';

export const defaultGates = Object.freeze({ probability: 0.95, confidence: 0.9 });
export const requestHash = (request) => createHash('sha256').update(JSON.stringify(request)).digest('hex');
const uncertain = (reason) => ({ status: 'INCONCLUSIVE', reason });
const probability = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const outcomes = ['satisfied', 'violated', 'insufficient_evidence'];

export function hardVerdict(result) {
  if (!Array.isArray(result?.checks) || result.checks.length === 0) return uncertain('No executed checks');
  if (result.hardStatus === 'FAIL' || result.checks.some((check) => check?.status === 'FAIL')) {
    return { status: 'FAIL', reason: result.reason || 'A hard assertion failed' };
  }
  if (result.hardStatus !== 'PASS' || result.checks.some((check) => check?.status !== 'PASS')) {
    return uncertain(result.reason || 'Hard assertions incomplete');
  }
  return { status: 'PASS', reason: 'Hard assertions passed' };
}

export function verdict(result, request, envelope) {
  const hard = hardVerdict(result);
  if (hard.status !== 'PASS') return hard;
  if (!request) return result.requestSha256 ? uncertain('Missing bound Jev request') : hard;
  const entries = Object.entries(request.questions ?? {});
  if (!entries.length || result.requestSha256 !== requestHash(request)) return uncertain('Invalid or changed Jev request');
  const gates = result.gates;
  if (!gates || !probability(gates.probability) || !probability(gates.confidence)) return uncertain('Invalid acceptance gates');
  if (!envelope) return uncertain('Awaiting a real Jev response');
  if (envelope.requestSha256 !== result.requestSha256 || envelope.runId !== result.runId) {
    return uncertain('Response belongs to another run or request');
  }
  const response = envelope.response;
  if (typeof response?.model !== 'string' || !response.model || !response.answers
      || Object.keys(response.answers).length !== entries.length) return uncertain('Invalid answer set');
  let needsReview = false;
  let failed = false;
  for (const [id, question] of entries) {
    const answer = response.answers[id];
    const keys = Object.keys(question.criteria ?? {});
    const probabilities = answer?.probabilities ?? {};
    const values = Object.values(probabilities);
    const valid = question.type === 'choice' && answer?.type === 'choice'
      && keys.length === 3 && outcomes.every((key) => keys.includes(key))
      && outcomes.includes(answer.choice) && values.length === 3
      && outcomes.every((key) => Object.hasOwn(probabilities, key))
      && [...values, answer.confidence].every(probability)
      && Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) < 0.02
      && probabilities[answer.choice] >= Math.max(...values);
    if (!valid) return uncertain(`Unsupported or malformed answer: ${id}`);
    const accepted = probabilities[answer.choice] >= gates.probability && answer.confidence >= gates.confidence;
    if (accepted && answer.choice === 'violated') failed = true;
    if (!accepted || answer.choice === 'insufficient_evidence') needsReview = true;
  }
  if (failed) return { status: 'FAIL', reason: 'A semantic assertion was violated' };
  return needsReview ? uncertain('Semantic assertions need review') : { status: 'PASS', reason: 'All required assertions passed' };
}
