#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const requestedClearAfter = Number(process.env.BITWARDEN_CLIPBOARD_CLEAR_MS);
const CLEAR_AFTER_MS = Number.isFinite(requestedClearAfter) ? Math.min(30_000, Math.max(0, requestedClearAfter)) : 30_000;
const COMMAND_TIMEOUT_MS = Math.min(20_000, Math.max(50, Number(process.env.BITWARDEN_COMMAND_TIMEOUT_MS) || 20_000));
const requestedClipboardTimeout = Number(process.env.BITWARDEN_CLIPBOARD_TIMEOUT_MS);
const CLIPBOARD_TIMEOUT_MS = Number.isFinite(requestedClipboardTimeout) ? Math.min(20_000, Math.max(50, requestedClipboardTimeout)) : 20_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const requestedClipboardReadTimeout = Number(process.env.BITWARDEN_CLIPBOARD_READ_TIMEOUT_MS);
const CLIPBOARD_READ_TIMEOUT_MS = Number.isFinite(requestedClipboardReadTimeout) ? Math.min(3000, Math.max(50, requestedClipboardReadTimeout)) : 3000;
const LOG_PREFIX = "BW_PLUGIN_LOG ";
const PUBLIC_ERRORS = Object.freeze({
  invalid_request: "The request could not be processed.",
  unlock_failed: "Could not unlock the vault. Check your master password and try again.",
  not_authenticated: "Sign in first by running bw login in a terminal.",
  locked: "The vault is locked. Unlock it to continue.",
  network_failure: "Bitwarden is unavailable. Check your connection and try again.",
  timeout: "Bitwarden did not respond in time. Try again.",
  clipboard_failure: "Could not update the clipboard.",
  cli_failure: "Bitwarden operation failed. Try again.",
});

function errorCategory(message) {
  if (/decryption operation failed|cryptography error|invalid master password/i.test(message)) return "unlock_failed";
  if (/not logged in|unauthenticated/i.test(message)) return "not_authenticated";
  if (/session.*(expired|invalid)|vault is locked/i.test(message)) return "locked";
  if (/network|fetch|econn|enotfound/i.test(message)) return "network_failure";
  if (/timed out/i.test(message)) return "timeout";
  return "cli_failure";
}

function safeError(code) {
  const error = new Error(PUBLIC_ERRORS[code] || PUBLIC_ERRORS.cli_failure);
  error.publicCode = PUBLIC_ERRORS[code] ? code : "cli_failure";
  return error;
}

function logEvent(event, details = {}) {
  process.stderr.write(LOG_PREFIX + JSON.stringify({ at: new Date().toISOString(), event, ...details }) + "\n");
}

function killChild(child, signal) {
  if (!child?.pid) return;
  try {
    if (child.detachedGroup && process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { child.kill(signal); }
}

function terminateChild(child, signal = "SIGTERM") {
  killChild(child, signal);
  const escalation = setTimeout(() => killChild(child, "SIGKILL"), 500);
  escalation.unref();
  return escalation;
}

function spawnManaged(command, args, options = {}) {
  const detachedGroup = process.platform !== "win32";
  const child = spawn(command, args, { ...options, detached: detachedGroup });
  child.detachedGroup = detachedGroup;
  return child;
}

function collect(child, { input = "", timeoutMs = COMMAND_TIMEOUT_MS, maxBytes = MAX_OUTPUT_BYTES, onChild = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let failure = null;
    let escalation = null;
    let settled = false;
    const timeout = setTimeout(() => {
      failure = safeError("timeout");
      escalation = terminateChild(child);
    }, timeoutMs);
    const failAndTerminate = error => {
      if (failure) return;
      failure = error;
      escalation = terminateChild(child);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      if (error) reject(error); else resolve(value);
    };
    const append = (current, chunk) => {
      if (failure) return current;
      const next = Buffer.concat([current, chunk]);
      if (next.length > maxBytes) {
        failAndTerminate(safeError("cli_failure"));
        return current;
      }
      return next;
    };
    onChild(child);
    child.stdout?.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", chunk => { stderr = append(stderr, chunk); });
    child.on("error", () => failAndTerminate(safeError("cli_failure")));
    child.stdin?.on("error", () => failAndTerminate(safeError("cli_failure")));
    child.on("close", code => {
      if (failure) finish(failure);
      else if (code === 0) finish(null, stdout.toString("utf8"));
      else finish(safeError(errorCategory(stderr.toString("utf8"))));
    });
    if (child.stdin) child.stdin.end(input);
    else if (input) failAndTerminate(safeError("cli_failure"));
  });
}

let activeChild = null;
let cleanupOnSignal = null;
function runBw(args, session, input = "") {
  const env = { ...process.env };
  delete env.BW_SESSION;
  if (session) env.BW_SESSION = session;
  const operation = args[0] === "get" ? `get.${args[1]}` : args[0];
  const startedAt = Date.now();
  logEvent("bw.started", { operation });
  const child = spawnManaged("bw", args, { env, stdio: ["pipe", "pipe", "pipe"] });
  activeChild = child;
  return collect(child, { input, onChild: () => { activeChild = child; } }).then(output => {
    logEvent("bw.finished", { operation, ok: true, durationMs: Date.now() - startedAt });
    return output;
  }, error => {
    logEvent("bw.finished", { operation, ok: false, durationMs: Date.now() - startedAt, errorCategory: error.publicCode || "cli_failure" });
    throw error;
  }).finally(() => { if (activeChild === child) activeChild = null; });
}

function visibleLoginItems(raw) {
  const items = JSON.parse(raw);
  if (!Array.isArray(items)) throw safeError("cli_failure");
  const logins = [];
  for (const item of items) {
    if (!item || item.type !== 1 || item.deletedDate || item.archivedDate) continue;
    const id = String(item.id || "");
    if (!id) continue;
    logins.push({ id, name: String(item.name || "Untitled login"), username: String(item.login?.username || ""), uri: String(item.login?.uris?.[0]?.uri || "") });
  }
  return logins;
}

function vaultState(raw) {
  const status = JSON.parse(raw)?.status;
  return ["unlocked", "locked", "unauthenticated"].includes(status) ? status : "unknown";
}

function runClipboard(args, input = "") {
  return collect(spawnManaged("wl-copy", args, { stdio: ["pipe", "ignore", "ignore"] }), { input, timeoutMs: CLIPBOARD_TIMEOUT_MS, maxBytes: 1024 });
}

function scheduleClipboardClear(value) {
  const child = spawnManaged(process.execPath, [SCRIPT, "clear-after"], { stdio: ["pipe", "ignore", "ignore"] });
  child.on("error", () => logEvent("clipboard.clear-helper", { ok: false, errorCategory: "cli_failure" }));
  child.stdin?.on("error", () => logEvent("clipboard.clear-helper", { ok: false, errorCategory: "cli_failure" }));
  if (child.stdin) child.stdin.end(value);
  else terminateChild(child);
  child.unref();
}

async function copySecret(value, field) {
  const startedAt = Date.now();
  logEvent("clipboard.started", { operation: `copy.${field}` });
  try {
    await runClipboard(["--type", "text/plain", "--sensitive"], value);
    logEvent("clipboard.finished", { operation: `copy.${field}`, ok: true, durationMs: Date.now() - startedAt });
    scheduleClipboardClear(value);
  } catch {
    logEvent("clipboard.finished", { operation: `copy.${field}`, ok: false, durationMs: Date.now() - startedAt, errorCategory: "clipboard_failure" });
    throw safeError("clipboard_failure");
  }
}

async function clearClipboardIfUnchanged(value) {
  await new Promise(resolve => setTimeout(resolve, CLEAR_AFTER_MS));
  const current = await collect(spawnManaged("wl-paste", ["--no-newline", "--type", "text/plain"], { stdio: ["ignore", "pipe", "ignore"] }), { timeoutMs: CLIPBOARD_READ_TIMEOUT_MS, maxBytes: MAX_OUTPUT_BYTES }).catch(() => null);
  if (current === value) await runClipboard(["--clear"]).catch(() => {});
}

async function unlockWithPassword(password) {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (!runtimeDir || !isAbsolute(runtimeDir) || typeof process.getuid !== "function") throw safeError("unlock_failed");
  const runtimeStat = await stat(runtimeDir);
  if (!runtimeStat.isDirectory() || runtimeStat.uid !== process.getuid() || (runtimeStat.mode & 0o077) !== 0) throw safeError("unlock_failed");
  const tempDir = await mkdtemp(join(runtimeDir, "omarchy-bitwarden-"));
  const passwordFile = join(tempDir, "master-password");
  const onSignal = async signal => {
    const child = activeChild;
    killChild(child, "SIGTERM");
    if (child && child.exitCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => killChild(child, "SIGKILL"), 500);
        child.once("close", () => { clearTimeout(timer); resolve(); });
      });
    }
    await rm(tempDir, { recursive: true, force: true });
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const sigterm = () => onSignal("SIGTERM");
  const sigint = () => onSignal("SIGINT");
  process.once("SIGTERM", sigterm);
  process.once("SIGINT", sigint);
  cleanupOnSignal = () => { process.off("SIGTERM", sigterm); process.off("SIGINT", sigint); };
  try {
    await writeFile(passwordFile, `${password}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(passwordFile, 0o600);
    const output = await runBw(["unlock", "--passwordfile", passwordFile, "--raw"], "");
    return output.replace(/[\r\n]+$/, "");
  } catch (error) {
    const code = error.publicCode || "unlock_failed";
    throw safeError(["timeout", "network_failure", "not_authenticated"].includes(code) ? code : "unlock_failed");
  } finally {
    cleanupOnSignal?.();
    cleanupOnSignal = null;
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function readRequestLine() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const newline = chunk.indexOf(0x0a);
    const part = newline < 0 ? chunk : chunk.subarray(0, newline);
    bytes += part.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw safeError("invalid_request");
    chunks.push(part);
    if (newline >= 0) return Buffer.concat(chunks, bytes).toString("utf8");
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

async function readAllStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.byteLength;
    if (bytes > MAX_OUTPUT_BYTES) throw safeError("invalid_request");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

let diagnosticAction = "invalid";

async function main() {
  const requestedAction = process.argv[2];
  if (requestedAction === "clear-after") { await clearClipboardIfUnchanged(await readAllStdin()); return; }
  const actions = ["unlock", "status", "list", "copy-password", "copy-username", "lock"];
  if (!actions.includes(requestedAction)) throw safeError("invalid_request");
  const action = requestedAction;
  diagnosticAction = action;
  logEvent("request.started", { action });
  let request;
  try { request = JSON.parse(await readRequestLine() || "{}"); } catch { throw safeError("invalid_request"); }
  if (!request || typeof request !== "object" || Array.isArray(request)) throw safeError("invalid_request");
  if (Object.hasOwn(request, "session") && typeof request.session !== "string") throw safeError("invalid_request");
  if (Object.hasOwn(request, "password") && typeof request.password !== "string") throw safeError("invalid_request");
  if (Object.hasOwn(request, "id") && typeof request.id !== "string") throw safeError("invalid_request");
  const session = request.session || "";
  let result;
  try {
    switch (action) {
      case "unlock": {
        if (typeof request.password !== "string" || !request.password) throw safeError("unlock_failed");
        const password = request.password;
        request.password = "";
        result = await unlockWithPassword(password);
        if (!result) throw safeError("unlock_failed");
        break;
      }
      case "status": result = vaultState(await runBw(["status", "--raw"], "")); break;
      case "list":
        if (!session) throw safeError("locked");
        result = visibleLoginItems(await runBw(["list", "items", "--raw"], session));
        break;
      case "copy-password":
      case "copy-username": {
        if (!session) throw safeError("locked");
        const id = typeof request.id === "string" ? request.id : "";
        if (!/^[0-9a-f-]{36}$/i.test(id)) throw safeError("invalid_request");
        const field = action === "copy-password" ? "password" : "username";
        const value = await runBw(["get", field, id, "--raw"], session);
        if (!value.length) throw safeError("cli_failure");
        await copySecret(value, field);
        result = { copied: field };
        break;
      }
      case "lock":
        if (session) await runBw(["lock"], session);
        result = { locked: true };
        break;
    }
  } catch (error) {
    const code = error.publicCode || errorCategory(error.message || "");
    throw safeError(code);
  }
  logEvent("request.finished", { action, ok: true });
  process.stdout.write(typeof result === "string" ? result : JSON.stringify(result));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    const code = error.publicCode || "cli_failure";
    if (diagnosticAction !== "invalid") logEvent("request.finished", { action: diagnosticAction, ok: false, errorCategory: code });
    process.stderr.write(PUBLIC_ERRORS[code] || PUBLIC_ERRORS.cli_failure);
    process.exitCode = 1;
  });
}

export { errorCategory, visibleLoginItems, vaultState, PUBLIC_ERRORS };
