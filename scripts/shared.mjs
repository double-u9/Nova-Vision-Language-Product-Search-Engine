import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const projectRoot = path.resolve(__dirname, "..");
export const envFilePath = path.join(projectRoot, ".env");
export const requirementsPath = path.join(projectRoot, "requirements.txt");

function parseEnvFile(contents) {
  const parsed = {};

  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
}

export function loadProjectEnv() {
  const loaded = {};

  if (fs.existsSync(envFilePath)) {
    Object.assign(loaded, parseEnvFile(fs.readFileSync(envFilePath, "utf8")));
  }

  for (const [key, value] of Object.entries(loaded)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }

  return { ...loaded, ...process.env };
}

export function getVenvPythonPath() {
  const windowsPython = path.join(projectRoot, ".venv", "Scripts", "python.exe");
  const unixPython = path.join(projectRoot, ".venv", "bin", "python");

  if (fs.existsSync(windowsPython)) {
    return windowsPython;
  }

  if (fs.existsSync(unixPython)) {
    return unixPython;
  }

  return null;
}

function getPythonVersion(command, args = []) {
  const result = spawnSync(
    command,
    [
      ...args,
      "-c",
      "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')",
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    },
  );

  if (result.status !== 0) {
    return null;
  }

  return result.stdout.trim();
}

function versionIsSupported(version) {
  return version === "3.11" || version === "3.12";
}

export function findSystemPython() {
  const env = loadProjectEnv();
  const candidates = [];

  if (env.NOVA_PYTHON) {
    candidates.push({ command: env.NOVA_PYTHON, args: [] });
  }

  if (process.platform === "win32") {
    candidates.push(
      { command: "py", args: ["-3.12"] },
      { command: "py", args: ["-3.11"] },
      { command: "python3.12", args: [] },
      { command: "python3.11", args: [] },
      { command: "python", args: [] },
      { command: "python3", args: [] },
    );
  } else {
    candidates.push(
      { command: "python3.12", args: [] },
      { command: "python3.11", args: [] },
      { command: "python3", args: [] },
      { command: "python", args: [] },
    );
  }

  const seen = new Set();

  for (const candidate of candidates) {
    const key = `${candidate.command} ${candidate.args.join(" ")}`.trim();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const version = getPythonVersion(candidate.command, candidate.args);
    if (version && versionIsSupported(version)) {
      return { ...candidate, version };
    }
  }

  return null;
}

export function runOrThrow(command, args, options = {}) {
  const needsShell =
    options.shell ??
    (process.platform === "win32" && /\.(cmd|bat)$/iu.test(command));

  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    stdio: options.stdio ?? "inherit",
    env: options.env ?? process.env,
    shell: needsShell,
    windowsHide: true,
  });

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with status ${result.status}`,
    );
  }

  if (result.error) {
    throw result.error;
  }

  return result;
}

export function requirementsHash() {
  const fileContents = fs.readFileSync(requirementsPath);
  return crypto.createHash("sha256").update(fileContents).digest("hex");
}

export function getRequirementsStampPath() {
  return path.join(projectRoot, ".venv", ".nova-requirements.sha256");
}

export function getFrontendCommand() {
  return process.execPath;
}

export function getFrontendArgs(args = []) {
  return [path.join(projectRoot, "node_modules", "vite", "bin", "vite.js"), ...args];
}

export function getDefaultApiBaseUrl() {
  const env = loadProjectEnv();
  const backendHost = env.BACKEND_HOST || "127.0.0.1";
  const backendPort = env.BACKEND_PORT || "5000";

  return env.VITE_API_BASE_URL || `http://${backendHost}:${backendPort}`;
}

export function spawnManaged(name, command, args, options = {}) {
  console.log(`[${name}] ${command} ${args.join(" ")}`);

  const needsShell =
    options.shell ??
    (process.platform === "win32" && /\.(cmd|bat)$/iu.test(command));

  return import("node:child_process").then(({ spawn }) =>
    spawn(command, args, {
      cwd: options.cwd ?? projectRoot,
      env: options.env ?? process.env,
      stdio: "inherit",
      shell: needsShell,
      windowsHide: true,
    }),
  );
}

export function terminateManagedProcess(child) {
  if (!child?.pid) {
    return;
  }

  if (process.platform === "win32") {
    const result = spawnSync(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      {
        cwd: projectRoot,
        stdio: "ignore",
        shell: false,
        windowsHide: true,
      },
    );

    const alreadyExited =
      typeof result.status === "number" && [0, 128, 255].includes(result.status);

    if (!alreadyExited && result.error) {
      console.warn(`Failed to stop process tree for PID ${child.pid}: ${result.error.message}`);
    }

    return;
  }

  if (!child.killed) {
    child.kill("SIGTERM");
  }
}

export function pathExists(filePath) {
  return fs.existsSync(filePath);
}

export function getOsShellName() {
  return os.platform();
}
