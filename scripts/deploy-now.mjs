import { execSync } from 'node:child_process';

function run(cmd, options = {}) {
  return execSync(cmd, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    ...options,
  }).trim();
}

function runPrint(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

function safeRun(cmd) {
  try {
    return run(cmd);
  } catch {
    return '';
  }
}

const providedMessage = process.argv.slice(2).join(' ').trim();
const now = new Date();
const timestamp = now.toISOString().replace('T', ' ').replace('Z', ' UTC');
const commitMessage = providedMessage || `deploy: ${timestamp}`;

const branch = run('git branch --show-current');
if (!branch) {
  console.error('Cannot determine current git branch.');
  process.exit(1);
}

const remoteUrl = safeRun('git remote get-url origin');
if (!remoteUrl) {
  console.error('Missing git remote "origin". Configure origin and retry.');
  process.exit(1);
}

console.log(`Deploying branch ${branch} to origin...`);

runPrint('git add -A');

const hasChanges = Boolean(safeRun('git status --porcelain'));
if (hasChanges) {
  // Escape embedded double-quotes for shell safety.
  const escaped = commitMessage.replace(/"/g, '\\"');
  runPrint(`git commit -m "${escaped}"`);
} else {
  console.log('No local changes to commit. Pushing latest branch state...');
}

runPrint(`git push origin ${branch}`);

const commitSha = safeRun('git rev-parse --short HEAD') || 'unknown';
console.log(`Deploy complete. Branch: ${branch}, Commit: ${commitSha}`);
