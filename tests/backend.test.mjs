import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { errorCategory, visibleLoginItems, vaultState, PUBLIC_ERRORS } from "../backend.mjs";

const backend = fileURLToPath(new URL("../backend.mjs", import.meta.url));
const node = process.execPath;
const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const request = value => JSON.stringify(value) + "\n";
const activeTestChildren = new Set();

async function waitFor(predicate, message, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "bitwarden-plugin-test-"));
  const bin = join(dir, "bin");
  const runtime = join(dir, "runtime");
  const clipboard = join(dir, "clipboard");
  const trace = join(dir, "trace.jsonl");
  const ready = join(dir, "bw-ready");
  mkdirSync(bin);
  mkdirSync(runtime, { mode: 0o700 });
  chmodSync(runtime, 0o700);
  writeFileSync(clipboard, "original clipboard");
  const shebang = `#!${node}`;
  const files = {
    bw: `${shebang}
const fs = require("node:fs");
const args = process.argv.slice(2);
const trace = x => fs.appendFileSync(process.env.FAKE_TRACE, JSON.stringify(x) + "\\n");
trace({ tool: "bw", pid: process.pid, args: args[0] });
if (process.env.FAKE_MODE === "error") { process.stderr.write("synthetic-password secret-session item-private-data"); process.exit(2); }
if (args[0] === "status") {
  if (process.env.BW_SESSION !== undefined) { process.stderr.write("ambient secret leaked"); process.exit(31); }
  process.stdout.write('{"status":"locked"}');
} else if (args[0] === "unlock") {
  const i = args.indexOf("--passwordfile");
  const file = args[i + 1];
  if (!file || !file.startsWith(process.env.XDG_RUNTIME_DIR + "/")) process.exit(8);
  if ((fs.statSync(file).mode & 0o777) !== 0o600) process.exit(9);
  if (fs.readFileSync(file, "utf8") !== "test-master-password\\n") process.exit(3);
  fs.writeFileSync(process.env.FAKE_READY, String(process.pid));
  if (["hang", "ignore", "overflow"].includes(process.env.FAKE_MODE)) {
    if (process.env.FAKE_MODE === "overflow") process.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 100, 65));
    process.on("SIGTERM", () => {});
    setTimeout(() => {}, 60000);
  }
  process.stdout.write("test-session-key");
} else if (args[0] === "list") {
  if (process.env.BW_SESSION !== "test-session-key") process.exit(5);
  process.stdout.write(JSON.stringify([{ id: "${ITEM_ID}", type: 1, name: "Example", login: { username: "alice", password: "private", uris: [{ uri: "https://example.test" }] } }]));
} else if (args[0] === "get") {
  if (process.env.BW_SESSION !== "test-session-key") process.exit(10);
  process.stdout.write(process.env.FAKE_CREDENTIAL || "utf8 ☃\\r\\nline\\n");
} else if (args[0] === "lock") {
  if (process.env.FAKE_LOCK_ERROR === "1") { process.stderr.write("secret-session private-vault"); process.exit(2); }
  process.stdout.write("");
} else process.exit(7);
`,
    "wl-copy": `${shebang}
const fs = require("node:fs");
const trace = x => fs.appendFileSync(process.env.FAKE_TRACE, JSON.stringify(x) + "\\n");
trace({ tool: "wl-copy", pid: process.pid, parent: process.ppid });
if (process.env.FAKE_COPY_ERROR === "1") process.exit(12);
if (process.env.FAKE_COPY_HANG === "1") {
  process.on("SIGTERM", () => {});
  setTimeout(() => {}, 60000);
}
const chunks = [];
process.stdin.on("data", x => chunks.push(x));
process.stdin.on("end", () => {
  if (process.argv.includes("--clear")) fs.writeFileSync(process.env.FAKE_CLIPBOARD, "");
  else fs.writeFileSync(process.env.FAKE_CLIPBOARD, Buffer.concat(chunks));
});
`,
    "wl-paste": `${shebang}
const fs = require("node:fs");
const trace = x => fs.appendFileSync(process.env.FAKE_TRACE, JSON.stringify(x) + "\\n");
trace({ tool: "wl-paste", pid: process.pid, parent: process.ppid });
if (process.env.FAKE_PASTE_ERROR === "1") process.exit(1);
if (process.env.FAKE_PASTE_HANG === "1") {
  process.on("SIGTERM", () => {});
  setTimeout(() => {}, 60000);
}
if (process.env.FAKE_REPLACE_BEFORE_PASTE) fs.writeFileSync(process.env.FAKE_CLIPBOARD, process.env.FAKE_REPLACE_BEFORE_PASTE);
process.stdout.write(fs.readFileSync(process.env.FAKE_CLIPBOARD));
`,
  };
  for (const [name, source] of Object.entries(files)) {
    const path = join(bin, name);
    writeFileSync(path, source);
    chmodSync(path, 0o700);
  }
  const env = {
    PATH: bin,
    XDG_RUNTIME_DIR: runtime,
    FAKE_CLIPBOARD: clipboard,
    FAKE_TRACE: trace,
    FAKE_READY: ready,
    BITWARDEN_CLIPBOARD_CLEAR_MS: "500",
  };
  const fixtureData = { dir, bin, runtime, clipboard, trace, ready, env };
  try {
    await run(fixtureData);
  } finally {
    await Promise.all([...activeTestChildren].map(child => new Promise(resolve => {
      if (child.exitCode !== null) { activeTestChildren.delete(child); resolve(); return; }
      child.once("close", () => { activeTestChildren.delete(child); resolve(); });
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { resolve(); } }
    })));
    if (existsSync(trace)) {
      const pids = new Set();
      for (const line of readFileSync(trace, "utf8").trim().split("\n")) {
        if (!line) continue;
        const record = JSON.parse(line);
        pids.add(record.pid);
        if (record.parent) pids.add(record.parent);
      }
      for (const pid of pids) {
        if (!pidAlive(pid)) continue;
        try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
      }
      try { await waitFor(() => [...pids].every(pid => !pidAlive(pid)), "fixture child processes should be terminated", 3000); } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function runSync(action, input, bin, env = {}, { timeout = 6000 } = {}) {
  return spawnSync(node, [backend, action], {
    input,
    encoding: "utf8",
    env: { ...env, PATH: bin },
    timeout,
  });
}

function runAsync(action, input, bin, env = {}) {
  const child = spawn(node, [backend, action], { env: { ...env, PATH: bin }, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  activeTestChildren.add(child);
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", x => stdout.push(x));
  child.stderr.on("data", x => stderr.push(x));
  const closed = new Promise(resolve => child.once("close", (code, signal) => {
    activeTestChildren.delete(child);
    resolve({ code, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), pid: child.pid });
  }));
  child.stdin.end(input);
  return { child, closed };
}

function logEntries(stderr) {
  return stderr.split("\n").filter(line => line.startsWith("BW_PLUGIN_LOG ")).map(line => JSON.parse(line.slice("BW_PLUGIN_LOG ".length)));
}

test("login projection excludes passwords, notes, deleted items and non-logins", () => {
  const rows = visibleLoginItems(JSON.stringify([
    { id: ITEM_ID, type: 1, name: "Example", login: { username: "alice", password: "secret", uris: [{ uri: "https://example.test" }] }, notes: "private" },
    { id: "note", type: 2, name: "Note" }, { id: "deleted", type: 1, deletedDate: "today" },
  ]));
  assert.deepEqual(rows, [{ id: ITEM_ID, name: "Example", username: "alice", uri: "https://example.test" }]);
  assert.equal(JSON.stringify(rows).includes("secret"), false);
  assert.throws(() => visibleLoginItems("{}"));
});

test("diagnostic JSON is newline framed and public errors survive the QML stderr parser", async () => {
  await fixture(async ({ bin, env }) => {
    const result = runSync("status", "not-json\n", bin, env);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes("\\n"), false);
    assert.equal(result.stderr.includes("\n"), true);
    const qml = readFileSync(new URL("../Bitwarden.qml", import.meta.url), "utf8");
    const parser = extractFunction(qml, "handleBackendStderr");
    const diagnostics = [];
    const context = { console: { info: message => diagnostics.push(message) }, JSON, String };
    const parse = vm.runInNewContext(`(${parser})`, context);
    const userError = parse(result.stderr);
    assert.equal(userError, PUBLIC_ERRORS.invalid_request);
    assert.equal(diagnostics.length, 2);
    assert.equal(diagnostics.every(line => line.includes("event=")), true);
    const entries = logEntries(result.stderr);
    assert.deepEqual(entries.map(entry => entry.event), ["request.started", "request.finished"]);
    assert.equal(entries[1].errorCategory, "invalid_request");
  });
});

test("unknown action arguments are not copied into diagnostics", async () => {
  await fixture(async ({ bin, env }) => {
    const result = runSync("password-secret-session", "{}\n", bin, env);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /password-secret-session/);
    assert.deepEqual(logEntries(result.stderr), []);
  });
});

test("request parser validates object shape, byte bounds and hides parser details", async () => {
  await fixture(async ({ bin, env }) => {
    for (const input of ["not-json\n", "null\n", "[]\n", "{\"session\":42}\n", "x".repeat(70 * 1024)]) {
      const result = runSync("list", input, bin, env);
      assert.equal(result.status, 1);
      assert.equal(result.stderr.includes("SyntaxError"), false);
      assert.doesNotMatch(result.stderr, /secret-session|item-private-data/);
      assert.match(result.stderr, /request could not be processed|vault is locked/i);
    }
  });
});

test("request UTF-8 is decoded after chunk collection and malformed details stay private", async () => {
  await fixture(async ({ bin, env }) => {
    const input = Buffer.from('{"password":"☃-secret"}\n');
    const result = await new Promise(resolve => {
      const child = spawn(node, [backend, "unlock"], { env: { ...env, PATH: bin }, stdio: ["pipe", "pipe", "pipe"] });
      const output = []; const errors = [];
      child.stdout.on("data", x => output.push(x)); child.stderr.on("data", x => errors.push(x));
      child.stdin.write(input.subarray(0, 15));
      setTimeout(() => child.stdin.end(input.subarray(15)), 5);
      child.once("close", code => resolve({ code, stdout: Buffer.concat(output).toString(), stderr: Buffer.concat(errors).toString() }));
    });
    assert.equal(result.code, 1);
    assert.equal(result.stderr.includes("☃-secret"), false);
    assert.match(result.stderr, /Could not unlock/);
  });
});

test("unlock uses a private password file, then removes it", async () => {
  await fixture(async ({ bin, runtime, env }) => {
    const result = runSync("unlock", request({ password: "test-master-password" }), bin, { ...env, BW_SESSION: "ambient-secret" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "test-session-key");
    assert.deepEqual(readdirSync(runtime), []);
    assert.equal(result.stderr.includes("test-master-password"), false);
  });
});

test("status mock proves ambient BW_SESSION is absent and list receives request session", async () => {
  await fixture(async ({ bin, env }) => {
    const status = runSync("status", "{}\n", bin, { ...env, BW_SESSION: "ambient-secret" });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout, "locked");
    const list = runSync("list", request({ session: "test-session-key" }), bin, { ...env, BW_SESSION: "ambient-secret" });
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), [{ id: ITEM_ID, name: "Example", username: "alice", uri: "https://example.test" }]);
  });
});

test("raw credential transfer preserves exact UTF-8 and CRLF bytes", async () => {
  await fixture(async ({ bin, clipboard, env }) => {
    const exact = "päss ☃\r\nsecond\n";
    const result = runSync("copy-password", request({ session: "test-session-key", id: ITEM_ID }), bin, { ...env, FAKE_CREDENTIAL: exact });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { copied: "password" });
    assert.deepEqual(readFileSync(clipboard), Buffer.from(exact));
    await waitFor(() => readFileSync(env.FAKE_TRACE, "utf8").includes('"tool":"wl-paste"'), "clear helper should invoke only fixture wl-paste");
    const trace = readFileSync(env.FAKE_TRACE, "utf8");
    const helperParent = JSON.parse(trace.split("\n").find(line => line.includes('"tool":"wl-paste"'))).parent;
    await waitFor(() => !pidAlive(helperParent), "clear-after helper should finish and be reaped");
  });
});

test("clipboard unchanged/replaced/read-error cases are isolated and awaited", async () => {
  await fixture(async ({ bin, clipboard, env }) => {
    const helperEnv = { ...env, BITWARDEN_CLIPBOARD_CLEAR_MS: "0" };
    writeFileSync(clipboard, "different");
    const unchanged = runSync("clear-after", "copied", bin, helperEnv);
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.equal(readFileSync(clipboard, "utf8"), "different");
    writeFileSync(clipboard, "copied");
    const replaced = runSync("clear-after", "copied", bin, { ...helperEnv, FAKE_REPLACE_BEFORE_PASTE: "newer value" });
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.equal(readFileSync(clipboard, "utf8"), "newer value");
    const failedRead = runSync("clear-after", "copied", bin, { ...helperEnv, FAKE_PASTE_ERROR: "1" });
    assert.equal(failedRead.status, 0, failedRead.stderr);
    assert.equal(readFileSync(clipboard, "utf8"), "newer value");
    const hungRead = runSync("clear-after", "copied", bin, { ...helperEnv, FAKE_PASTE_HANG: "1", BITWARDEN_CLIPBOARD_READ_TIMEOUT_MS: "100" }, { timeout: 5000 });
    assert.equal(hungRead.status, 0, hungRead.stderr);
    assert.equal(readFileSync(clipboard, "utf8"), "newer value");
    const trace = readFileSync(env.FAKE_TRACE, "utf8").trim().split("\n").map(JSON.parse);
    const reader = trace.filter(x => x.tool === "wl-paste").at(-1).pid;
    await waitFor(() => !pidAlive(reader), "hung clipboard reader should be terminated");
  });
});

test("copy failure and hanging clipboard tools return safely after cleanup", async () => {
  await fixture(async ({ bin, env }) => {
    const failed = runSync("copy-password", request({ session: "test-session-key", id: ITEM_ID }), bin, { ...env, FAKE_COPY_ERROR: "1" });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Could not update the clipboard/);
    const hung = runSync("copy-password", request({ session: "test-session-key", id: ITEM_ID }), bin, { ...env, FAKE_COPY_HANG: "1", BITWARDEN_CLIPBOARD_TIMEOUT_MS: "1000" }, { timeout: 6000 });
    assert.equal(hung.status, 1);
    assert.match(hung.stderr, /Could not update the clipboard/);
    const trace = readFileSync(env.FAKE_TRACE, "utf8").trim().split("\n").map(JSON.parse);
    const clipboardPid = trace.filter(x => x.tool === "wl-copy").at(-1).pid;
    await waitFor(() => !pidAlive(clipboardPid), "hung clipboard writer should be terminated");
  });
});

test("CLI output overflow waits for SIGKILL escalation and leaves no child or password file", async () => {
  await fixture(async ({ bin, runtime, ready, env }) => {
    const { child, closed } = runAsync("unlock", request({ password: "test-master-password" }), bin, { ...env, FAKE_MODE: "overflow", BITWARDEN_COMMAND_TIMEOUT_MS: "5000" });
    await waitFor(() => existsSync(ready), "fake bw should open the password file before overflow");
    const pid = Number(readFileSync(ready, "utf8"));
    const result = await closed;
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Could not unlock the vault/);
    assert.deepEqual(readdirSync(runtime), []);
    await waitFor(() => !pidAlive(pid), "overflowing bw process should be killed before backend completion");
    assert.notEqual(child.pid, undefined);
  });
});

test("timeout escalates against SIGTERM-ignoring bw and cleans password file", async () => {
  await fixture(async ({ bin, runtime, ready, env }) => {
    const { closed } = runAsync("unlock", request({ password: "test-master-password" }), bin, { ...env, FAKE_MODE: "ignore", BITWARDEN_COMMAND_TIMEOUT_MS: "1000" });
    await waitFor(() => existsSync(ready), "fake bw should open the password file before timeout");
    const pid = Number(readFileSync(ready, "utf8"));
    const result = await closed;
    assert.equal(result.code, 1);
    assert.match(result.stderr, /did not respond in time/);
    assert.deepEqual(readdirSync(runtime), []);
    await waitFor(() => !pidAlive(pid), "timed-out bw process should be killed before backend completion");
  });
});

test("SIGTERM and SIGINT after fake CLI opens password file terminate child and remove file", async t => {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    await t.test(signal, async () => fixture(async ({ bin, runtime, ready, env }) => {
      const { child, closed } = runAsync("unlock", request({ password: "test-master-password" }), bin, { ...env, FAKE_MODE: "ignore" });
      await waitFor(() => existsSync(ready), "fake bw must confirm password-file open before signal");
      const pid = Number(readFileSync(ready, "utf8"));
      child.kill(signal);
      const result = await closed;
      assert.equal(result.code, signal === "SIGTERM" ? 143 : 130);
      assert.deepEqual(readdirSync(runtime), []);
      await waitFor(() => !pidAlive(pid), "signaled bw process should be terminated");
    }));
  }
});

test("secret-containing CLI and parser errors are mapped to safe public text", async () => {
  await fixture(async ({ bin, env }) => {
    const result = runSync("list", request({ session: "test-session-key" }), bin, { ...env, FAKE_MODE: "error" });
    assert.equal(result.status, 1);
    for (const secret of ["synthetic-password", "secret-session", "item-private-data"]) assert.equal(result.stderr.includes(secret), false);
    assert.match(result.stderr, /Bitwarden operation failed/);
    const errors = logEntries(result.stderr);
    assert.equal(errors.filter(x => x.event === "request.finished").length, 1);
  });
});

test("actual QML lifecycle functions reject stale completions, clear immediately, drain queued lock, and retain expiry", async () => {
  const qml = readFileSync(new URL("../Bitwarden.qml", import.meta.url), "utf8");
  const harness = makeQmlHarness(qml);
  const r = harness.root;
  r.open("{}");
  assert.equal(r.pendingAction, "status");
  harness.exit(0, "locked");
  r.masterPassword = "fixture password";
  r.unlock();
  r.items = [{ id: ITEM_ID, name: "synthetic item" }];
  r.masterPassword = "fixture password";
  r.lockVault();
  assert.equal(r.sessionKey, "");
  assert.equal(r.items.length, 0);
  assert.equal(r.masterPassword, "");
  assert.equal(r.queuedLock, true);
  harness.exit(0, "late-unlock-session");
  assert.equal(r.pendingAction, "lock");
  assert.equal(r.sessionKey, "");
  assert.equal(harness.actionProc.lastRequest.session, "late-unlock-session");
  harness.exit(1, "", "BW_PLUGIN_LOG {\"at\":\"fixed\",\"event\":\"request.finished\",\"action\":\"lock\",\"ok\":false,\"errorCategory\":\"cli_failure\"}\nBitwarden operation failed. Try again.");
  assert.equal(r.queuedLock, false);
  assert.equal(r.lockSession, "");
  assert.equal(r.state, "locked");
  assert.equal(r.statusMessage, "Bitwarden operation failed. Try again.");

  r.open("{}");
  harness.exit(0, "locked");
  r.masterPassword = "fixture password";
  r.unlock();
  r.close();
  assert.equal(r.opened, false);
  harness.exit(0, "new-session");
  assert.equal(r.sessionKey, "");
  assert.equal(r.pendingAction, "lock");
  r.open("{}");
  harness.exit(0, "{\"locked\":true}");
  assert.equal(r.queuedLock, false);
  assert.equal(r.lockSession, "");
  assert.equal(r.pendingAction, "status");
  harness.exit(0, "locked");
  assert.equal(r.opened, true);

  const lateList = makeQmlHarness(qml);
  lateList.root.sessionKey = "list-session";
  lateList.root.items = [{ id: ITEM_ID }];
  lateList.root.open("{}");
  assert.equal(lateList.root.pendingAction, "list");
  lateList.root.close();
  assert.equal(lateList.root.items.length, 0);
  lateList.root.open("{}");
  lateList.exit(0, '[{"id":"late","name":"stale"}]');
  assert.equal(lateList.root.items.length, 0);
  assert.equal(lateList.root.sessionKey, "");
  assert.equal(lateList.root.pendingAction, "lock");
  lateList.exit(1, "", "Bitwarden operation failed. Try again.");
  assert.equal(lateList.root.queuedLock, false);
  assert.equal(lateList.root.sessionKey, "");

  r.sessionKey = "session";
  r.items = [{ id: ITEM_ID }];
  r.open("{}");
  const expiryRestarts = harness.sessionExpiry.restartCount;
  r.open("{}");
  assert.equal(r.pendingAction, "list");
  harness.exit(0, "[]");
  assert.equal(harness.sessionExpiry.restartCount, expiryRestarts);
  assert.equal(r.queuedLock, false);
  assert.equal(r.pendingPayload && Object.keys(r.pendingPayload).length, 0);
  assert.match(qml, /interval: 300000/);
  assert.equal((qml.match(/textFormat: Text\.PlainText/g) || []).length, (qml.match(/\bText \{/g) || []).length);
});

test("password-field Escape invokes actual dismissal handler while locked or unlocking", () => {
  const qml = readFileSync(new URL("../Bitwarden.qml", import.meta.url), "utf8");
  const harness = makeQmlHarness(qml);
  const inputBlock = qml.slice(qml.indexOf("id: passwordField"));
  const handler = inputBlock.match(/Keys\.onPressed: function\(event\) \{[\s\S]*?\n          \}/)?.[0];
  assert.ok(handler, "password field should have a keyboard handler");
  const fn = vm.runInNewContext(`(${handler.slice(handler.indexOf("function"), handler.lastIndexOf("}") + 1)})`, harness.context);
  harness.root.opened = true;
  harness.root.state = "locked";
  const event = { key: 1, modifiers: 0, accepted: false };
  harness.context.Qt.Key_Escape = 1;
  fn(event);
  assert.equal(event.accepted, true);
  assert.equal(harness.root.opened, false);

  harness.root.open("{}");
  harness.exit(0, "locked");
  harness.root.masterPassword = "synthetic unlock";
  harness.root.unlock();
  const unlockEscape = { key: 1, modifiers: 0, accepted: false };
  fn(unlockEscape);
  assert.equal(unlockEscape.accepted, true);
  assert.equal(harness.root.opened, false);
  assert.equal(harness.root.queuedLock, true);
  harness.exit(0, "late-session");
  assert.equal(harness.root.sessionKey, "");
  assert.equal(harness.root.pendingAction, "lock");
  harness.exit(0, "{\"locked\":true}");
  assert.equal(harness.root.queuedLock, false);
});

test("normalizers retain safe categories", () => {
  assert.equal(errorCategory("network timeout"), "network_failure");
  assert.equal(errorCategory("unrecognized private details"), "cli_failure");
  assert.equal(vaultState('{"status":"unlocked"}'), "unlocked");
  assert.equal(vaultState('{"status":"unexpected"}'), "unknown");
  assert.equal(PUBLIC_ERRORS.cli_failure, "Bitwarden operation failed. Try again.");
});

function extractFunction(source, name) {
  const match = new RegExp(`function ${name}\\([^)]*\\) \\{`).exec(source);
  assert.ok(match, `function ${name} exists`);
  const start = match.index;
  const brace = source.indexOf("{", start);
  return source.slice(start, matchingBrace(source, brace) + 1);
}

function matchingBrace(source, opening) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = opening; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  throw new Error("unclosed function block");
}

function makeQmlHarness(source) {
  const timers = () => ({ running: false, restartCount: 0, restart() { this.running = true; this.restartCount++; }, stop() { this.running = false; } });
  const sessionExpiry = timers();
  const statusTimer = timers();
  let onStarted = () => {};
  const actionProc = { command: [], lastRequest: null, _running: false };
  Object.defineProperty(actionProc, "running", {
    get() { return this._running; },
    set(value) { this._running = value; if (value) onStarted(); },
  });
  const root = {
    opened: false, state: "checking", statusMessage: "", sessionKey: "", masterPassword: "", filterText: "", items: [], selectedIndex: 0,
    pendingAction: "", pendingPayload: {}, copyTargetId: "", copyTargetField: "", copyFeedbackState: "idle", requestGeneration: 0, runningGeneration: 0,
    queuedLock: false, lockSession: "", shell: null, manifest: null, backend: "/fixture/backend.mjs",
  };
  const callbacks = [];
  const actionStdout = { text: "" };
  const actionStderr = { text: "" };
  const context = {
    root, actionProc, sessionExpiry, statusTimer, actionStdout, actionStderr,
    passwordField: { forceActiveFocus() {} }, searchField: { forceActiveFocus() {} },
    Qt: { callLater: callback => callbacks.push(callback), Key_Escape: 1, Key_L: 2, ControlModifier: 4 },
    console: { info() {} }, JSON, String, Math, Boolean,
    write: line => { actionProc.lastRequest = JSON.parse(line); },
  };
  for (const name of ["open", "forgetSession", "close", "dismiss", "toggle", "run", "checkStatus", "unlock", "loadItems", "lockVault", "handleBackendStderr", "handleResult"]) {
    root[name] = vm.runInNewContext(`(${extractFunction(source, name)})`, context);
  }
  const startedStart = source.indexOf("onStarted: {");
  assert.notEqual(startedStart, -1);
  const startedBrace = source.indexOf("{", startedStart);
  onStarted = vm.runInNewContext(`(function() ${source.slice(startedBrace, matchingBrace(source, startedBrace) + 1)})`, context);
  const exitedStart = source.indexOf("onExited: function(exitCode)");
  assert.notEqual(exitedStart, -1);
  const exitedBrace = source.indexOf("{", exitedStart);
  const exitedSource = source.slice(exitedStart + "onExited: ".length, matchingBrace(source, exitedBrace) + 1);
  const onExited = vm.runInNewContext(`(${exitedSource})`, context);
  function exit(code, stdout = "", stderr = "") {
    actionProc.running = false;
    actionStdout.text = stdout;
    actionStderr.text = stderr;
    onExited(code);
    while (callbacks.length) callbacks.shift()();
  }
  return { root, context, sessionExpiry, statusTimer, actionProc, exit };
}
