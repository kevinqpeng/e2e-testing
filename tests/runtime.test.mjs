import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { defaultGates, hardVerdict, requestHash, verdict } from '../scripts/judgments.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const request = { state: { message: 'No matching entries' }, questions: { empty: {
  type: 'choice', instructions: 'Does the text describe an empty result?',
  criteria: { satisfied: 'yes', violated: 'no', insufficient_evidence: 'unclear' },
} } };
const base = { runId: 'fixture-run', hardStatus: 'PASS', checks: [{ name: 'UI assertion', status: 'PASS' }],
  gates: { ...defaultGates }, requestSha256: requestHash(request) };
const answer = (choice = 'satisfied', confidence = 0.99) => ({ type: 'choice', choice, confidence,
  probabilities: Object.fromEntries(['satisfied', 'violated', 'insufficient_evidence'].map((key) => [key, key === choice ? 0.99 : 0.005])) });
const envelope = (choice = 'satisfied') => ({ runId: base.runId, requestSha256: base.requestSha256,
  response: { model: 'offline-fixture-not-a-real-model-call', answers: { empty: answer(choice) } } });

test('negative, uncertain, malformed and stale model responses never turn green', () => {
  assert.equal(verdict(base, request, envelope()).status, 'PASS');
  assert.equal(verdict(base, request, envelope('violated')).status, 'FAIL');
  assert.equal(verdict(base, request, envelope('insufficient_evidence')).status, 'INCONCLUSIVE');
  assert.equal(verdict(base, request).status, 'INCONCLUSIVE');
  assert.equal(verdict(base, undefined).status, 'INCONCLUSIVE');
  assert.equal(verdict(base, { ...request, state: {} }, envelope()).status, 'INCONCLUSIVE');
  assert.equal(verdict(base, request, { ...envelope(), runId: 'another-run' }).status, 'INCONCLUSIVE');
  const low = envelope(); low.response.answers.empty.confidence = 0.7;
  assert.equal(verdict(base, request, low).status, 'INCONCLUSIVE');
  const malformed = envelope(); malformed.response.answers.empty.probabilities.satisfied = '0.99';
  assert.equal(verdict(base, request, malformed).status, 'INCONCLUSIVE');
  const unknown = envelope(); unknown.response.answers.empty.choice = 'not-in-criteria';
  assert.equal(verdict(base, request, unknown).status, 'INCONCLUSIVE');
  assert.equal(verdict({ ...base, hardStatus: 'FAIL' }, request, envelope()).status, 'FAIL');
  assert.equal(hardVerdict({ hardStatus: 'PASS', checks: [] }).status, 'INCONCLUSIVE');
  assert.equal(hardVerdict({ hardStatus: 'PASS', checks: [null] }).status, 'INCONCLUSIVE');
  assert.equal(hardVerdict({ hardStatus: 'PASS', checks: [{ status: 'FAIL' }] }).status, 'FAIL');
});

test('the complete skill runs from both project and global layouts without original paths', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'e2e-skill-test-'));
  try {
    const bin = join(temporary, 'bin');
    const project = join(temporary, 'unrelated project');
    await mkdir(bin); await mkdir(project);
    // An explicit offline stub: it exercises packaging and process contracts, not browser behavior.
    const fake = join(bin, 'fake.mjs');
    await writeFile(fake, `import fs from 'node:fs';
globalThis.taskSpace = async () => ({ spaceId: 101 });
const input = fs.readFileSync(0, 'utf8');
await new (Object.getPrototypeOf(async function(){}).constructor)(input)();
if (process.env.E2E_TEST_FORCE_CRASH) process.exit(1);
`);
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    await writeFile(join(bin, 'ego-browser'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)}\n`, { mode: 0o755 });
    const scenario = join(project, 'case.mjs');
    await writeFile(scenario, `import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export const name='fixture';
export async function run(task, config) {
  if(config.request !== undefined) await writeFile(join(config.output,'jev-request.json'),JSON.stringify(config.request));
  return { hardStatus:'PASS', checks:[{name:'offline contract check',status:'PASS'}] };
}`);
    const config = join(project, 'config.json');
    const installed = [join(project, '.agents/skills/e2e-testing'), join(temporary, 'isolated user/.codex/skills/e2e-testing')];
    for (const destination of installed) {
      await cp(source, destination, { recursive: true, filter: (path) => !['.git', 'node_modules'].includes(path.split('/').at(-1)) });
      const runner = join(destination, 'scripts/runner.mjs');
      const run = (args, extraEnv = {}) => spawnSync(process.execPath, [runner, ...args], { cwd: project, encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, E2E_SPACE_ID: '', ...extraEnv } });
      assert.equal(run(['--help']).status, 0);
      const first = run(['--scenario', scenario]);
      assert.equal(first.status, 0, first.stderr);
      const firstOut = JSON.parse(first.stdout.trim().split('\n').at(-1)).output;
      const previous = await readFile(join(firstOut, 'result.json'), 'utf8');
      const second = run(['--scenario', scenario]);
      assert.equal(second.status, 0, second.stderr);
      assert.notEqual(JSON.parse(second.stdout.trim().split('\n').at(-1)).output, firstOut);
      assert.equal(await readFile(join(firstOut, 'result.json'), 'utf8'), previous);
      const report = await readFile(join(firstOut, 'report.md'), 'utf8');
      assert.ok(!report.includes('app-device.png') && !report.includes('admin-detail.png'));
      assert.equal(run(['--scenario', scenario, '--output', join(destination, '..private')]).status, 2);
      assert.equal(run(['--scenario', scenario, '--typo', 'value']).status, 2);
      assert.equal(run(['--scenario', scenario], { E2E_TEST_FORCE_CRASH: '1' }).status, 2);
      await writeFile(config, JSON.stringify({ request }));
      const pending = run(['--scenario', scenario, '--config', config]);
      assert.equal(pending.status, 2, pending.stderr);
      const directory = JSON.parse(pending.stdout.trim().split('\n').at(-1)).output;
      const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
      const receipt = { ...envelope('violated'), runId: result.runId, requestSha256: result.requestSha256 };
      const receiptPath = join(project, 'offline-envelope.json');
      await writeFile(receiptPath, JSON.stringify(receipt));
      assert.equal(run(['--finalize', directory, receiptPath]).status, 1);
      await writeFile(config, JSON.stringify({ request: null }));
      assert.equal(run(['--scenario', scenario, '--config', config]).status, 2);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
