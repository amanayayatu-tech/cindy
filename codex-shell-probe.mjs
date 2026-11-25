import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const binary = process.env.CINDY_CODEX_TEST_BINARY;
assert.ok(binary, 'Set CINDY_CODEX_TEST_BINARY to the absolute Codex binary path.');
const windows = process.platform === 'win32';
const root = await mkdtemp(path.join(tmpdir(), 'cindy-shell-fixture-'));
const codexHome = path.join(root, 'codex');
const cwd = path.join(root, '验收 日本語 with spaces');
const fileName = '输入 文件.txt';
const fileContents = 'UNICODE_CWD_OK';
const template = '<div v-if="ready" @click="run($event)">{{ name }}</div>';
const sentinel = 'CINDY_SHELL_FIXTURE_OK';
const windowsCommand = [
  '$ErrorActionPreference = "Stop"',
  '$render = & {',
  "@'",
  template,
  "'@",
  '}',
  '$value = & { param([string]$file) [IO.File]::ReadAllText($file) } (Join-Path (Get-Location).Path "输入 文件.txt")',
  'if ($value -cne "UNICODE_CWD_OK") { throw "Unexpected fixture contents" }',
  '[Console]::WriteLine($render)',
  '[Console]::WriteLine("' + sentinel + '")',
].join('\n');
const posixCommand = [
  'set -e',
  'test "$(cat \'输入 文件.txt\')" = UNICODE_CWD_OK',
  "cat <<'CINDY_FIXTURE'",
  template,
  sentinel,
  'CINDY_FIXTURE',
].join('\n');
const logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child: () => logger,
};

let advertisedTools = [];
let toolName;
let toolOutput;
let fixtureError;
let calls = 0;
const server = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const step = calls++;
    let item;
    if (step === 0) {
      advertisedTools = (input.tools ?? []).map(tool => tool.name);
      toolName = windows || advertisedTools.includes('shell_command') ? 'shell_command' : 'exec_command';
      assert.ok(advertisedTools.includes(toolName), 'Missing ' + toolName + ': ' + advertisedTools.join(', '));
      item = { type: 'function_call', id: 'item-shell', call_id: 'call-shell', name: toolName,
        arguments: JSON.stringify({ [toolName === "exec_command" ? "cmd" : "command"]: windows ? windowsCommand : posixCommand, workdir: cwd }) };
    } else {
      toolOutput = input.input?.find(entry => entry.call_id === 'call-shell' && entry.type.endsWith('_call_output'))?.output;
      item = { type: 'message', id: 'item-done', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture finished.' }] };
    }
    const events = [
      { type: 'response.created', response: { id: 'local-fixture-' + step } },
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id: 'local-fixture-' + step,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    res.end(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''));
  } catch (error) {
    fixtureError = error;
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: error.message } }));
  }
});
let agent;
let handle;
const watchdog = setTimeout(() => {
  console.error('Timed out waiting for local Codex shell fixture.');
  process.exitCode = 1;
  void agent?.dispose();
  server.closeAllConnections();
}, 55_000);
try {
  await mkdir(codexHome);
  await mkdir(cwd);
  await writeFile(path.join(cwd, fileName), fileContents, 'utf8');
  if (windows) {
    assert.equal(process.arch, 'x64', 'Run on a native Windows x64 Node installation.');
    const windowsPowerShell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    for (const powerShell of ['pwsh.exe', windowsPowerShell]) {
      const control = execFileSync(powerShell, ['-NoLogo', '-NoProfile', '-NonInteractive',
        '-EncodedCommand', Buffer.from(windowsCommand, 'utf16le').toString('base64')], { cwd, encoding: 'utf8', timeout: 10000 });
      assert.ok(control.includes(template) && control.includes(sentinel), 'Direct PowerShell control output mismatch');
      console.log('DIRECT_POWERSHELL_OK ' + (powerShell === 'pwsh.exe' ? 'PowerShell 7' : 'Windows PowerShell 5.1'));
    }
  }
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  await writeFile(path.join(codexHome, 'config.toml'), [
    'model="fixture-model"', 'model_provider="fixture"', 'cli_auth_credentials_store="ephemeral"',
    'check_for_update_on_startup=false', '[features]', 'shell_tool=true', 'unified_exec=false', 'shell_snapshot=false',
    '[analytics]', 'enabled=false', '[model_providers.fixture]', 'name="Fixture"',
    'base_url="' + endpoint + '"', 'wire_api="responses"', 'requires_openai_auth=false', 'request_max_retries=0',
  ].join('\n') + '\n', 'utf8');
  const { CodexAgent } = await import(pathToFileURL(path.resolve('packages/maker-core/src/agents/codex/index.ts')).href);
  agent = new CodexAgent({
    binaryPath: binary, logger, runtimeConfig: {},
    resolveCodexLocalAuthPolicy: () => 'isolated',
    prepareCodexExtraSpawnConfig: async () => ({ extraArgs: [], extraEnv: {}, codexProxyActive: true }),
    auth: {
      getState: async () => ({ authenticated: true }),
      triggerLogin: async () => ({ authenticated: true }),
      logout: async () => {},
      getAuthEnv: async () => ({
        HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
        CODEX_HOME: codexHome, TMPDIR: root, OPENAI_API_KEY: '', CODEX_API_KEY: '',
        HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
        ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost',
      }),
    },
  });
  handle = await agent.startSession({
    sessionId: 'isolated-shell-probe', providerId: 'cprov-fixture',
    model: 'fixture-model', workingDir: cwd, makerMemoryEnabled: false,
  });
  const done = (async () => {
    for await (const event of handle.events()) {
      if (event.type === 'error' && event.data?.isTerminal !== false) throw fixtureError ?? new Error('Cindy agent reported a terminal error');
      if (event.type === 'done') return;
    }
  })();
  await Promise.all([handle.send({ type: 'user', content: 'Run the synthetic shell fixture.' }, { throwOnStartFailure: true }), done]);
  assert.ifError(fixtureError);
  assert.equal(calls, 2);
  const output = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput);
  const result = { templatePreserved: Boolean(output?.includes(template)), sentinelFound: Boolean(output?.includes(sentinel)) };
  console.log(JSON.stringify({ tool: toolName, ...result }));
  assert.ok(result.templatePreserved && result.sentinelFound, 'Cindy shell output mismatch');
  assert.equal(await readFile(path.join(cwd, fileName), 'utf8'), fileContents);
  console.log(JSON.stringify({ verdict: 'CINDY_NATIVE_SHELL_OK', platform: process.platform, arch: process.arch,
    codex: execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), tool: toolName, requests: calls }));
} catch (error) {
  const safe = typeof error?.message === 'string' && /^(Missing (shell_command|exec_command): [\w, -]+|Cindy agent reported a terminal error|Cindy shell output mismatch|Direct PowerShell control output mismatch)$/.test(error.message);
  console.error(safe ? error.message : 'Fixture setup or execution failed. See completed stage markers.');
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await handle?.close();
  await agent?.dispose();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
