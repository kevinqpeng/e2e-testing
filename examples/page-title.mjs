import assert from 'node:assert/strict';
import { join } from 'node:path';

export const name = 'page-title';
export const title = 'Page title smoke check';

export async function run(task, config) {
  const page = task.page('p1');
  const checks = [];
  const result = { spaceId: task.spaceId, scope: 'One configured page title; not a complete business lifecycle', checks, artifacts: [] };
  try {
    assert.ok(config.url && config.expectedTitle, 'Provide url and expectedTitle in config');
    const url = new URL(config.url);
    assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'Use a credential-free HTTP(S) URL');
    await page.goto(url.href);
    const actual = await page.title();
    assert.equal(actual, config.expectedTitle, 'Page title');
    checks.push({ name: 'Expected page title', status: 'PASS' });
    await page.screenshot({ path: join(config.output, 'page.png') });
    result.artifacts.push('page.png');
    result.hardStatus = 'PASS';
    await task.finish({ keep: [] });
  } catch (error) {
    result.hardStatus = error.name === 'AssertionError' ? 'FAIL' : 'INCONCLUSIVE';
    result.reason = error.message;
    checks.push({ name: 'Expected page title', status: result.hardStatus });
    // Retain the task for inspection, including when the user took control.
  }
  return result;
}
