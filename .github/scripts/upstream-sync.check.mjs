import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { git, candidateBranch, existingCandidate, prepareCandidate, protectedPaths, verifyCandidate } from './upstream-sync.mjs';

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-upstream-test-'));
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Update fixture');
  git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  const commit = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), content);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-m', 'fixture change');
    return git(cwd, 'rev-parse', 'HEAD');
  };
  const common = commit('app.md', 'original\n');
  git(cwd, 'switch', '-c', 'upstream');
  const releaseSha = commit('upstream.md', 'release\n');
  git(cwd, 'switch', 'main');
  const base = commit('local-security.md', 'retain local protections\n');
  return { cwd, common, base, releaseSha, commit, tag: 'v1.2.3', bundlePath: path.join(cwd, '..', `${path.basename(cwd)}.bundle`) };
}

test('require stable releases and immutable commit identifiers', () => {
  assert.match(candidateBranch('v1.2.3', 'a'.repeat(40)), /^codex\/upstream-v1\.2\.3-/);
  for (const tag of ['v1.2.3-rc1', 'v1.2', '../main', 'v01.2.3']) assert.throws(() => candidateBranch(tag, 'a'.repeat(40)));
  assert.throws(() => candidateBranch('v1.2.3', 'main'));
});

test('preserve both histories and local files, and make reruns a no-op', () => {
  const f = fixture();
  const result = prepareCandidate(f);
  assert.equal(result.status, 'ready');
  verifyCandidate(f.cwd, result);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'local-security.md'), 'utf8'), 'retain local protections\n');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'upstream.md'), 'utf8'), 'release\n');
  git(f.cwd, 'bundle', 'verify', f.bundlePath);
  const before = git(f.cwd, 'rev-parse', 'HEAD');
  assert.equal(prepareCandidate({ ...f, base: before }).status, 'current');
  assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), before);
});

test('leave a conflicting update at the original baseline without losing patches', () => {
  const f = fixture();
  f.commit('app.md', 'local change\n');
  f.base = git(f.cwd, 'rev-parse', 'HEAD');
  git(f.cwd, 'switch', 'upstream');
  f.releaseSha = f.commit('app.md', 'upstream change\n');
  git(f.cwd, 'switch', 'main');
  const result = prepareCandidate(f);
  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.conflicts, ['app.md']);
  assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), f.base);
  assert.equal(git(f.cwd, 'status', '--porcelain'), '');
  assert.equal(fs.existsSync(f.bundlePath), false);
});

test('stop before testing or publishing upstream changes to workflow privileges', () => {
  const f = fixture();
  git(f.cwd, 'switch', 'upstream');
  f.releaseSha = f.commit('.github/workflows/new.yml', 'permissions: write-all\n');
  git(f.cwd, 'switch', 'main');
  const result = prepareCandidate(f);
  assert.equal(result.status, 'manual_review');
  assert.deepEqual(result.sensitive, ['.github/workflows/new.yml']);
  assert.equal(fs.existsSync(f.bundlePath), false);
  assert.deepEqual(protectedPaths(['src/app.ts', '.gitmodules', '.gitattributes']), ['.gitmodules', '.gitattributes']);
});

test('refuse dirty or stale baselines and invalid manifests', () => {
  const f = fixture();
  assert.throws(() => prepareCandidate({ ...f, base: f.common }), /baseline/);
  fs.writeFileSync(path.join(f.cwd, 'pending.md'), 'uncommitted');
  assert.throws(() => prepareCandidate(f), /clean disposable checkout/);
  assert.throws(() => verifyCandidate(f.cwd, { status: 'ready', base: f.base, head: f.base, releaseSha: f.releaseSha, branch: candidateBranch(f.tag, f.releaseSha), tag: f.tag }), /histories/);
});

test('keep one candidate open and do not reopen a rejected release automatically', () => {
  const branch = candidateBranch('v1.2.3', 'a'.repeat(40));
  const open = { state: 'open', head: { ref: 'codex/upstream-v1.2.2-previous' }, html_url: 'https://example.invalid/1' };
  assert.equal(existingCandidate([open], branch).status, 'pending_review');
  assert.equal(existingCandidate([{ ...open, state: 'closed', head: { ref: branch } }], branch).status, 'previously_reviewed');
  assert.equal(existingCandidate([{ ...open, state: 'closed' }], branch), null);
  const f = fixture();
  assert.equal(prepareCandidate({ ...f, pulls: [open] }).status, 'pending_review');
  assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), f.base);
});

test('validate scheduling, least privilege and explicit tests before publication', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const read = name => yaml.load(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'));
  const update = read('upstream-sync.yml');
  const validation = read('validate.yml');
  const ci = read('ci.yml');
  assert.ok(update.on.schedule[0].cron);
  assert.ok(Object.hasOwn(update.on, 'workflow_dispatch'));
  assert.deepEqual(update.permissions, { contents: 'read' });
  assert.equal(update.jobs.validate.uses, './.github/workflows/validate.yml');
  assert.match(update.jobs.publish.if, /needs\.validate\.result == 'success'/);
  assert.deepEqual(update.jobs.publish.permissions, { contents: 'write', 'pull-requests': 'write' });
  assert.equal(update.concurrency['cancel-in-progress'], false);
  const publish = JSON.stringify(update.jobs.publish);
  assert.doesNotMatch(publish, /npm |cargo |secrets:.*inherit/);
  assert.equal(ci.jobs.check.uses, './.github/workflows/validate.yml');
  const steps = validation.jobs.check.steps;
  assert.ok(steps.some(s => s.run?.includes('npm run test:mocks')));
  assert.ok(steps.some(s => s.run?.includes('cargo test --locked --lib')));
  assert.ok(steps.some(s => s.run?.includes('npm run build')));
  assert.doesNotMatch(JSON.stringify(validation), /secrets\./);
  for (const workflow of [update, validation]) for (const job of Object.values(workflow.jobs)) for (const step of job.steps || []) {
    if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
  }
});


test('recreate the same commit in a fresh retry checkout after interrupted publication', () => {
  const f = fixture();
  const first = prepareCandidate(f);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-upstream-retry-'));
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Update fixture');
  git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  git(cwd, 'fetch', f.cwd, f.base, f.releaseSha);
  git(cwd, 'checkout', '--detach', f.base);
  const retry = prepareCandidate({ ...f, cwd, bundlePath: path.join(cwd, '..', path.basename(cwd) + '.bundle') });
  assert.equal(retry.status, 'ready');
  assert.equal(retry.head, first.head);
  verifyCandidate(cwd, retry);
});

test('pin Node 24 action upgrades and keep the manual artifact check read-only', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const pins = new Map([
    ['actions/checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1'],
    ['actions/upload-artifact', 'cf430e030ddbb5b0abf93d22962f4752f3646cd9'],
    ['actions/download-artifact', '9000827ccba6bdab643e8b6fd33ac0654aef8333'],
    ['actions/setup-node', '949feb2413d6458794dcd2491c4babbbce0c15c1'],
    ['Swatinem/rust-cache', 'd1527c8f67ef9af357290475d4af4b0fab8f12e0'],
    ['tauri-apps/tauri-action', '1deb371b0cd8bd54025b384f1cd735e725c4060f'],
  ]);
  const read = name => yaml.load(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'));
  for (const name of ['upstream-sync.yml', 'validate.yml', 'build.yml', 'actions-smoke.yml']) {
    for (const job of Object.values(read(name).jobs)) for (const step of job.steps || []) {
      if (!step.uses) continue;
      assert.match(step.uses, /@[a-f0-9]{40}$/);
      const [action, sha] = step.uses.split('@');
      assert.notEqual(action, 'arduino/setup-protoc');
      if (pins.has(action)) assert.equal(sha, pins.get(action));
      if (action === 'actions/setup-node') {
        assert.equal(step.with['node-version'], '22');
        assert.equal(step.with['package-manager-cache'], false);
      }
      if (action === 'actions/checkout') assert.notEqual(step.with?.['allow-unsafe-pr-checkout'], true);
    }
  }
  const smoke = read('actions-smoke.yml');
  assert.deepEqual(Object.keys(smoke.on), ['workflow_dispatch']);
  assert.deepEqual(smoke.permissions, { contents: 'read' });
  const job = smoke.jobs['artifact-round-trip'];
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.ok(job['timeout-minutes'] <= 10);
  assert.equal(job.steps.find(s => s.uses?.startsWith('actions/checkout@')).with['persist-credentials'], false);
  assert.equal(job.steps.find(s => s.uses?.startsWith('actions/upload-artifact@')).with['retention-days'], 1);
  assert.ok(job.steps.some(s => s.uses?.startsWith('actions/download-artifact@')));
  assert.ok(job.steps.some(s => s.run?.startsWith('cmp ')));
  assert.doesNotMatch(JSON.stringify(smoke), /secrets\.|npm |cargo |gh release|git push/);
  assert.deepEqual(read('ci.yml').jobs.check.strategy.matrix.platform, ['macos-latest', 'ubuntu-22.04', 'windows-latest']);
});

test('build ad-hoc manual macOS bundles without empty Apple signing variables', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const job = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/build.yml'), 'utf8')).jobs.build;
  const step = name => {
    const found = job.steps.find(s => s.name === name);
    assert.ok(found, `missing step: ${name}`);
    return found;
  };
  const position = name => job.steps.indexOf(step(name));
  const mac = "startsWith(matrix.platform, 'macos-')";
  // An unset secret still becomes an empty variable, and Tauri imports any APPLE_CERTIFICATE variable.
  assert.equal(job.env.APPLE_SIGNING_CONFIGURED, "${{ secrets.APPLE_CERTIFICATE != '' }}");

  const guard = step('Require Apple signing for tagged macOS releases');
  assert.equal(guard.if, `github.event_name == 'push' && ${mac} && env.APPLE_SIGNING_CONFIGURED != 'true'`);
  assert.match(guard.run, /exit 1/);
  assert.equal(position('Require Apple signing for tagged macOS releases'), 0);

  const signed = step('Build Tauri app');
  assert.equal(signed.if, `env.APPLE_SIGNING_CONFIGURED == 'true' || !${mac}`);
  for (const name of ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']) {
    assert.equal(signed.env[name], `\${{ secrets.${name} }}`);
  }

  const adHoc = step('Build ad-hoc macOS test bundle');
  assert.equal(adHoc.if, `github.event_name == 'workflow_dispatch' && ${mac} && env.APPLE_SIGNING_CONFIGURED != 'true'`);
  assert.equal(adHoc.uses, signed.uses);
  assert.equal(adHoc.env, undefined);
  assert.deepEqual(adHoc.with, { args: '${{ matrix.args }}' });
  assert.doesNotMatch(JSON.stringify(adHoc), /secrets\.|GITHUB_TOKEN/);
  assert.ok(position('Build ad-hoc macOS test bundle') < position('Upload bundles as workflow artifacts (manual runs only)'));

  const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  assert.equal(config.bundle.macOS.signingIdentity, '-');
  assert.equal(step('Verify signed macOS app and DMG').if, `github.event_name == 'push' && ${mac}`);
});
