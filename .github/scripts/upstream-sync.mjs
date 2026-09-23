import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const upstream = 'nashsu/llm_wiki';
const prefix = 'codex/upstream-';
const stable = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const sha = /^[a-f0-9]{40}$/;

function command(file, args, cwd = process.cwd()) {
  return execFileSync(file, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function git(cwd, ...args) { return command('git', args, cwd); }
function api(endpoint) { return JSON.parse(command('gh', ['api', endpoint])); }
function ancestor(cwd, a, b) {
  try { git(cwd, 'merge-base', '--is-ancestor', a, b); return true; }
  catch (error) { if (error.status === 1) return false; throw error; }
}
function changed(cwd, base, head) {
  return git(cwd, 'diff', '--name-only', '-z', base, head).split('\0').filter(Boolean);
}
export function protectedPaths(files) {
  // Never execute or publish upstream changes to the updater's trust boundary.
  return files.filter(file => file.startsWith('.github/') || file === '.gitmodules' || file === '.gitattributes');
}
export function existingCandidate(pulls, branch) {
  const open = pulls.find(pr => pr.state === 'open' && pr.head.ref.startsWith(prefix));
  if (open) return { status: 'pending_review', pull: open.html_url };
  const previous = pulls.find(pr => pr.head.ref === branch);
  return previous ? { status: 'previously_reviewed', pull: previous.html_url } : null;
}
export function candidateBranch(tag, releaseSha) {
  if (!stable.test(tag) || !sha.test(releaseSha)) throw new Error('Require a stable release and full commit SHA.');
  return `${prefix}${tag}-${releaseSha.slice(0, 12)}`;
}

export function prepareCandidate({ cwd, base, releaseSha, tag, pulls = [], bundlePath }) {
  const branch = candidateBranch(tag, releaseSha);
  if (git(cwd, 'rev-parse', 'HEAD') !== base || git(cwd, 'status', '--porcelain')) {
    throw new Error('Require a clean disposable checkout at the recorded baseline.');
  }
  if (ancestor(cwd, releaseSha, base)) return { status: 'current', base, tag, releaseSha };
  const previous = existingCandidate(pulls, branch);
  if (previous) return { ...previous, base, tag, releaseSha };
  git(cwd, 'switch', '-c', branch);
  try { git(cwd, 'merge', '--no-ff', '--no-edit', releaseSha); }
  catch (error) {
    const conflicts = git(cwd, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
    if (!conflicts.length) throw error;
    git(cwd, 'merge', '--abort');
    return { status: 'conflict', base, releaseSha, tag, conflicts };
  }
  const head = git(cwd, 'rev-parse', 'HEAD');
  const files = changed(cwd, base, head);
  const sensitive = protectedPaths(files);
  if (sensitive.length) return { status: 'manual_review', base, head, tag, releaseSha, sensitive };
  // Include only candidate objects; the validation job already has the baseline.
  git(cwd, 'bundle', 'create', bundlePath, `refs/heads/${branch}`, `^${base}`);
  return { status: 'ready', base, head, releaseSha, branch, tag, filesChanged: files.length, commits: Number(git(cwd, 'rev-list', '--count', `${base}..${head}`)) };
}

export function verifyCandidate(cwd, manifest) {
  const { base, head, releaseSha, branch, tag } = manifest;
  if (manifest.status !== 'ready' || !sha.test(base) || !sha.test(head) || branch !== candidateBranch(tag, releaseSha)) throw new Error('Invalid candidate manifest.');
  if (!ancestor(cwd, base, head) || !ancestor(cwd, releaseSha, head)) throw new Error('Candidate does not preserve both histories.');
  if (protectedPaths(changed(cwd, base, head)).length) throw new Error('Candidate changes protected updater files.');
}

function pullsFor(repo) {
  const pages = JSON.parse(command('gh', ['api', '--paginate', '--slurp', `repos/${repo}/pulls?state=all&per_page=100`]));
  return pages.flat();
}
function saveReport(result, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'candidate.json'), JSON.stringify(result, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `status=${result.status}\nbase=${result.base || ''}\nhead=${result.head || ''}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const paths = result.conflicts || result.sensitive || [];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Upstream update\n\nStatus: **${result.status}**. Release: ${result.tag || 'unknown'}.\n\n${result.pull ? `Review: ${result.pull}\n` : ''}${paths.length ? `Manual attention: ${paths.length} paths. Read candidate.json for details.\n` : ''}\nNo application was installed or deployed.\n`);
  }
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Run this entry point only in its disposable GitHub Actions jobs.');
  const mode = process.argv[2];
  const cwd = process.cwd();
  const repo = process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') || repo === upstream) throw new Error('Require the maintained fork.');
  const outputDir = path.resolve(process.env.RUNNER_TEMP, 'upstream-candidate');
  if (mode === 'prepare') {
    fs.mkdirSync(outputDir, { recursive: true });
    const info = api(`repos/${repo}`);
    const branch = info.default_branch;
    if (process.env.GITHUB_REF !== `refs/heads/${branch}`) throw new Error('Run update preparation from the default branch only.');
    const base = git(cwd, 'rev-parse', 'HEAD');
    if (api(`repos/${repo}/commits/${encodeURIComponent(branch)}`).sha !== base) throw new Error('Baseline advanced; rerun from the current default branch.');
    const release = api(`repos/${upstream}/releases/latest`);
    if (release.draft || release.prerelease || !stable.test(release.tag_name)) throw new Error('Latest release is not a supported stable version.');
    git(cwd, 'fetch', '--no-tags', `https://github.com/${upstream}.git`, `refs/tags/${release.tag_name}`);
    const releaseSha = git(cwd, 'rev-parse', 'FETCH_HEAD^{commit}');
    git(cwd, 'config', 'user.name', 'github-actions[bot]');
    git(cwd, 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
    const result = prepareCandidate({ cwd, base, releaseSha, tag: release.tag_name, pulls: pullsFor(repo), bundlePath: path.join(outputDir, 'candidate.bundle') });
    saveReport({ ...result, defaultBranch: branch }, outputDir);
    if (result.status === 'conflict' || result.status === 'manual_review') process.exitCode = 1;
    return;
  }
  if (mode !== 'publish') throw new Error('Unsupported operation.');
  const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'candidate.json'), 'utf8'));
  if (manifest.base !== process.env.EXPECTED_BASE || manifest.head !== process.env.EXPECTED_HEAD) throw new Error('Artifact does not match the preparation job.');
  if (process.env.VALIDATION_RESULT !== 'success') throw new Error('Do not publish an unverified candidate.');
  git(cwd, 'bundle', 'verify', path.join(outputDir, 'candidate.bundle'));
  git(cwd, 'fetch', path.join(outputDir, 'candidate.bundle'), `refs/heads/${manifest.branch}`);
  verifyCandidate(cwd, manifest);
  if (api(`repos/${repo}`).default_branch !== manifest.defaultBranch || api(`repos/${repo}/commits/${encodeURIComponent(manifest.defaultBranch)}`).sha !== manifest.base) {
    throw new Error('Default branch changed during validation; rerun preparation.');
  }
  const previous = existingCandidate(pullsFor(repo), manifest.branch);
  if (previous) { saveReport({ ...manifest, ...previous }, outputDir); return; }
  const existing = git(cwd, 'ls-remote', '--heads', 'origin', `refs/heads/${manifest.branch}`).split(/\s+/)[0];
  if (existing && existing !== manifest.head) throw new Error('Candidate branch changed; never overwrite maintainer work.');
  // Push only the recorded commit; do not check out or execute candidate code here.
  git(cwd, 'push', 'origin', `${manifest.head}:refs/heads/${manifest.branch}`);
  const body = `Integrate upstream ${manifest.tag} (${manifest.releaseSha}) into the maintained fork. Preserve both histories and the existing local patches.\n\nValidation passed on candidate ${manifest.head}: frontend typecheck/build and mock tests, MCP build/tests, native tests. No provider credentials or model calls were used.\n\nReview conflicts, security-sensitive behavior and the local-patch checklist in UPSTREAM_MAINTENANCE.md before merging. Perform the packaged-app and canary gates separately. This draft does not authorize installation or deployment.\n\nWorkflow: https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}\n`;
  const bodyPath = path.join(outputDir, 'pull-request.md');
  fs.writeFileSync(bodyPath, body);
  const url = command('gh', ['pr', 'create', '--repo', repo, '--base', manifest.defaultBranch, '--head', manifest.branch, '--draft', '--title', `chore(upstream): review ${manifest.tag}`, '--body-file', bodyPath]);
  saveReport({ ...manifest, status: 'draft_created', pull: url }, outputDir);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    // Avoid dumping subprocess environments, HTTP responses or credentials.
    const message = error.status === undefined ? error.message : `External command failed with status ${error.status}; inspect the bounded job steps.`;
    console.error(message);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nUpdate preparation stopped: ${message}\n`);
    process.exitCode = 1;
  });
}
