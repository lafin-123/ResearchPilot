#!/bin/sh
# POSIX bridge CLI. Node handles JSON/arguments; curl remains the HTTP transport.
set -eu
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'ResearchPilot CLI requires Node.js on PATH.' >&2
  exit 1
fi

exec node - "$@" <<'NODE'
const { readFileSync, statSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { spawnSync } = require('node:child_process');

const commands = {
  docs: ['list', 'read', 'create', 'write', 'compile'],
  refs: ['list', 'search', 'add', 'export'],
  exps: ['list', 'create', 'run', 'status', 'logs'],
  figs: ['list', 'create', 'get', 'update', 'export', 'render'],
  ssh: ['list', 'exec'],
  evidence: ['report']
};
const aliases = new Map([
  ['code-file', 'codeFile'], ['spec-file', 'specFile'], ['ssh-host-id', 'sshHostId'],
  ['experiment-id', 'experimentId'], ['document-id', 'documentId'], ['run-id', 'runId']
]);

function help() {
  console.log('ResearchPilot Bridge CLI\nUsage: research <status|docs|refs|exps|figs|ssh|evidence> [command] [--option value]');
  console.log('docs: list | read --id | create --title --format | write --id --file | compile --id');
  console.log('refs: list [--query] | search --query | add --doi | export');
  console.log('exps: list | create --name --code-file | run --id [--timeout] | status --id | logs --id');
  console.log('figs: list | create --spec-file <project.json> [--name] | get --id | update --id --spec-file | export --id --format pptx');
  console.log('figs legacy: render --name --code-file [--experiment-id] (Python, approval required; raster is not editable)');
  console.log('ssh: list | exec --host --command\nevidence: report');
}

function parseOptions(tokens) {
  const options = Object.create(null);
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].startsWith('--')) continue;
    const rawKey = tokens[i].slice(2);
    const key = aliases.get(rawKey) || rawKey;
    options[key] = i + 1 < tokens.length && !tokens[i + 1].startsWith('--') ? tokens[++i] : true;
  }
  for (const key of ['timeout', 'rows', 'port']) {
    if (!Object.hasOwn(options, key)) continue;
    const value = options[key] === true ? 1 : Number(options[key]);
    if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
      throw new Error(`--${key} requires an integer.`);
    }
    options[key] = value;
  }
  // Match PowerShell's boolean conversion (a present nonempty value is true).
  if (Object.hasOwn(options, 'remote')) options.remote = Boolean(options.remote);
  return options;
}

function findConfig() {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const path = join(dir, '.research', 'bridge.json');
    try {
      statSync(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cannot read .research/bridge.json.');
      if (dirname(dir) === dir) break;
      continue;
    }
    // Never fall back to a parent project's credentials when the nearest config is invalid.
    let config;
    try {
      const text = readFileSync(path, 'utf8');
      config = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    }
    catch { throw new Error('Invalid .research/bridge.json.'); }
    if (!config || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
        typeof config.token !== 'string' || !config.token || /[\x00-\x1f\x7f]/.test(config.token) ||
        typeof config.projectId !== 'string' || !config.projectId.trim()) {
      throw new Error('Invalid .research/bridge.json fields.');
    }
    return config;
  }
  throw new Error('No .research/bridge.json found. Run inside a ResearchPilot project and keep the app open.');
}

let token = '';
try {
  const argv = process.argv.slice(2);
  const group = argv[0];
  if (!group || group === 'help' || group === '--help') {
    help();
  } else {
    const sub = argv[1] && !argv[1].startsWith('--') ? argv[1] : '';
    if (group !== 'status' && (!Object.hasOwn(commands, group) || !commands[group].includes(sub))) {
      throw new Error('Unknown command. Run research help.');
    }
    const method = group === 'status' ? 'status' : `${group}.${sub}`;
    const options = parseOptions(argv.slice(sub ? 2 : 1));
    // These Windows CLI routes deliberately ignore options.
    const noOptions = new Set(['status', 'docs.list', 'refs.export', 'exps.list', 'figs.list', 'ssh.list', 'evidence.report']);
    const params = noOptions.has(method) ? {} : options;
    if (method === 'docs.create' && !params.format) params.format = 'docx';
    const config = findConfig();
    token = config.token;
    const response = spawnSync('curl', [
      '--disable', '--silent', '--show-error', '--fail', '--noproxy', '*',
      '--connect-timeout', '10', '--max-time', '86400',
      '--header', '@-', '--header', 'Content-Type: application/json; charset=utf-8',
      '--data-binary', JSON.stringify({ method, params, projectId: config.projectId }),
      `http://127.0.0.1:${config.port}/rpc`
    ], {
      // Keep credentials out of command arguments; never use a shell or emit raw curl errors.
      input: `Authorization: Bearer ${token}\n`, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
    });
    if (response.error || response.status !== 0) {
      throw new Error('Cannot connect to ResearchPilot Bridge (curl failed). Keep the app open and check curl is installed.');
    }
    let envelope;
    try { envelope = JSON.parse(response.stdout); }
    catch { throw new Error('Invalid JSON response from ResearchPilot Bridge.'); }
    if (!envelope || envelope.ok !== true) {
      throw new Error(typeof envelope?.error === 'string' ? envelope.error : 'ResearchPilot Bridge request failed.');
    }
    const result = envelope.result ?? null;
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'ResearchPilot CLI failed.';
  console.error(token ? message.split(token).join('[redacted]') : message);
  process.exitCode = 1;
}
NODE
