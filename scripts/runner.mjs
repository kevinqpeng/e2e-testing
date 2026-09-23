import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultGates, requestHash, verdict } from './judgments.mjs';

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const exitCode = (status) => status === 'PASS' ? 0 : status === 'FAIL' ? 1 : 2;
const help = `Collect: node <skill>/scripts/runner.mjs --scenario ./tests/e2e/case.mjs [--config ./tests/e2e/config.json] [--output ./.e2e-artifacts]
Finalize: node <skill>/scripts/runner.mjs --finalize RUN_DIRECTORY JEV_ENVELOPE_JSON
Reuse the current browser task with E2E_SPACE_ID=<id>. Exit codes: 0 PASS, 1 FAIL, 2 INCONCLUSIVE.
The skill is self-contained; scenarios/config and evidence belong to the target project.`;

async function optionalJson(path) {
  try { return await json(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function report(directory, result) {
  const cell = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
  const lines = [`# E2E: ${cell(result.scenarioTitle || result.case)}`, '', `**${result.status}** — ${cell(result.reason)}`, '',
    `Run: ${result.runId}`, `Started: ${result.startedAt}`, `Browser space: ${result.spaceId ?? 'unavailable'}`, '',
    '| Check | Status |', '| --- | --- |',
    ...(Array.isArray(result.checks) ? result.checks : []).map((check) => `| ${cell(check?.name)} | ${cell(check?.status)} |`), '',
    `Scope: ${cell(result.scope || 'Not specified by scenario')}`, '', '[Raw result](result.json)'];
  if (result.requestSha256) {
    lines.push('[Jev request](jev-request.json)', '',
      `Gates: probability >= ${result.gates.probability}, confidence >= ${result.gates.confidence}. These are not accuracy guarantees.`);
  }
  if (result.jev) {
    lines.push('[Jev response](jev-result.json)', '', '| Question | Choice | Probability | Confidence |', '| --- | --- | --- | --- |');
    for (const [id, answer] of Object.entries(result.jev.answers ?? {})) {
      lines.push(`| ${cell(id)} | ${cell(answer.choice)} | ${cell(answer.probabilities?.[answer.choice])} | ${cell(answer.confidence)} |`);
    }
  }
  for (const artifact of result.artifacts ?? []) {
    // Only explicit relative files inside this run are linked. Never assume a business-specific screenshot name.
    if (typeof artifact !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(artifact)
        || artifact.startsWith('/') || artifact.split('/').includes('..')) continue;
    try { await access(join(directory, artifact)); } catch { continue; }
    lines.push('', `[${artifact}](${artifact})`);
  }
  await writeFile(join(directory, 'report.md'), lines.join('\n') + '\n');
}

async function finalize(directory, envelopePath) {
  const result = await json(join(directory, 'result.json'));
  const request = await optionalJson(join(directory, 'jev-request.json'));
  const envelope = await json(envelopePath);
  const judged = verdict(result, request, envelope);
  // This file is an audit of a real external tool response, not a place to synthesize model answers.
  await save(join(directory, 'jev-result.json'), envelope);
  Object.assign(result, judged, { jev: envelope.response });
  await save(join(directory, 'result.json'), result);
  await report(directory, result);
  console.log(JSON.stringify({ status: result.status, reason: result.reason, report: join(directory, 'report.md') }));
  return exitCode(result.status);
}

export async function main(args = process.argv.slice(2)) {
  if (args[0] === '--finalize') {
    if (args.length !== 3) throw new Error(help);
    return finalize(resolve(args[1]), resolve(args[2]));
  }
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    scenario: { type: 'string' }, config: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(help); return 0; }
  if (!values.scenario) throw new Error(help);
  const scenarioPath = resolve(values.scenario);
  const scenarioInfo = await stat(scenarioPath);
  const scenarioDirectory = scenarioInfo.isDirectory() ? scenarioPath : undefined;
  const modulePath = scenarioDirectory ? join(scenarioDirectory, 'scenario.mjs') : scenarioPath;
  const scenario = await import(pathToFileURL(modulePath).href);
  if (typeof scenario.run !== 'function') throw new Error('Scenario must export run(task, config)');
  const configPath = values.config ? resolve(values.config)
    : scenarioDirectory ? join(scenarioDirectory, 'config.json') : undefined;
  const supplied = configPath ? await optionalJson(configPath) ?? {} : {};
  if (!supplied || Array.isArray(supplied) || typeof supplied !== 'object') throw new Error('Config must be a JSON object');
  const spaceId = process.env.E2E_SPACE_ID;
  if (spaceId && !/^[1-9]\d*$/.test(spaceId)) throw new Error('E2E_SPACE_ID must be a positive integer');
  const requestedOutput = resolve(values.output || '.e2e-artifacts');
  await mkdir(requestedOutput, { recursive: true });
  const outputRoot = realpathSync(requestedOutput);
  const inside = relative(skillRoot, outputRoot);
  if (!inside || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))) {
    throw new Error('Store evidence in the target project, outside the installed skill');
  }
  const output = await mkdtemp(join(outputRoot, `${new Date().toISOString().replaceAll(':', '-')}-`));
  const runId = randomUUID();
  const scenarioName = scenario.name || 'scenario';
  const startedAt = new Date().toISOString();
  const config = { ...supplied, output, runId, scenario: scenarioName, scenarioTitle: scenario.title || scenarioName };
  const input = `const {run} = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
const task = await taskSpace(${spaceId ? Number(spaceId) : JSON.stringify(`E2E ${config.scenarioTitle}`)});
console.log(JSON.stringify({spaceId:task.spaceId}));
const result = await run(task, ${JSON.stringify(config)});
if(result !== undefined) { const fs = await import('node:fs/promises'); await fs.writeFile(${JSON.stringify(join(output, 'result.json'))}, JSON.stringify(result)); }`;
  const child = spawnSync('ego-browser', ['nodejs'], { input, encoding: 'utf8', timeout: 240_000, maxBuffer: 2 * 1024 * 1024 });
  process.stdout.write(child.stdout || '');
  process.stderr.write(child.stderr || '');
  let result;
  let request;
  try {
    result = await json(join(output, 'result.json'));
    if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('Invalid scenario result');
    request = await optionalJson(join(output, 'jev-request.json'));
    if (request !== undefined && (!request || Array.isArray(request) || typeof request !== 'object')) {
      throw new Error('Invalid Jev request');
    }
  } catch (error) {
    result = { hardStatus: 'INCONCLUSIVE', checks: [], reason: `Missing or malformed evidence: ${error.message}` };
  }
  Object.assign(result, { runId, case: scenarioName, scenarioTitle: config.scenarioTitle, startedAt, finishedAt: new Date().toISOString() });
  if (child.error || child.status !== 0) {
    result.hardStatus = result.hardStatus === 'FAIL' ? 'FAIL' : 'INCONCLUSIVE';
    result.reason = child.error?.message || `Browser exited ${child.status}; inspect its task before retrying`;
  }
  if (request) {
    result.requestSha256 = requestHash(request);
    result.gates = { ...defaultGates }; // Freeze gates for this run; finalization does not read later defaults.
  }
  Object.assign(result, verdict(result, request));
  await save(join(output, 'result.json'), result);
  await report(output, result);
  console.log(JSON.stringify({ status: result.status, hardStatus: result.hardStatus, runId, output }));
  return exitCode(result.status);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.message); process.exitCode = 2; });
}
