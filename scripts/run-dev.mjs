import path from "node:path";

import { ensurePythonEnvironment } from "./setup-python.mjs";
import {
  getFrontendArgs,
  getDefaultApiBaseUrl,
  getFrontendCommand,
  loadProjectEnv,
  projectRoot,
  spawnManaged,
  terminateManagedProcess,
} from "./shared.mjs";

const env = loadProjectEnv();
const pythonPath = ensurePythonEnvironment();
const frontendCommand = getFrontendCommand();
const frontendHost = env.FRONTEND_HOST || "127.0.0.1";
const frontendPort = env.FRONTEND_PORT || "3000";
const backendHost = env.BACKEND_HOST || "127.0.0.1";
const backendPort = env.BACKEND_PORT || "5000";
const apiBaseUrl = getDefaultApiBaseUrl();
const backendReloadEnabled =
  env.NOVA_BACKEND_RELOAD === "1" || env.NOVA_BACKEND_RELOAD === "true";

const backendEnv = {
  ...process.env,
  BACKEND_HOST: backendHost,
  BACKEND_PORT: backendPort,
  NOVA_HOST: backendHost,
  NOVA_PORT: backendPort,
  NOVA_CORS_ORIGINS:
    env.NOVA_CORS_ORIGINS ||
    `http://localhost:${frontendPort},http://127.0.0.1:${frontendPort}`,
};

const frontendEnv = {
  ...process.env,
  FRONTEND_HOST: frontendHost,
  FRONTEND_PORT: frontendPort,
  VITE_API_BASE_URL: apiBaseUrl,
};

const children = [];
let isShuttingDown = false;

function shutdown(exitCode = 0) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  for (const child of children) {
    terminateManagedProcess(child);
  }

  setTimeout(() => process.exit(exitCode), 400);
}

function attachLifecycle(child, name) {
  child.on("exit", (code, signal) => {
    if (isShuttingDown) {
      return;
    }

    if (code === 0 || signal === "SIGTERM") {
      shutdown(0);
      return;
    }

    console.error(`[${name}] exited unexpectedly with code ${code ?? "unknown"}`);
    shutdown(typeof code === "number" ? code : 1);
  });

  child.on("error", (error) => {
    console.error(`[${name}] ${error.message}`);
    shutdown(1);
  });
}

const backend = await spawnManaged(
  "api",
  pythonPath,
  [
    "-m",
    "uvicorn",
    "server:app",
    "--host",
    backendHost,
    "--port",
    backendPort,
    ...(backendReloadEnabled ? ["--reload"] : []),
  ],
  {
    cwd: path.join(projectRoot, "nova"),
    env: backendEnv,
  },
);

const frontend = await spawnManaged(
  "web",
  frontendCommand,
  getFrontendArgs(["--host", frontendHost, "--port", frontendPort]),
  {
    cwd: projectRoot,
    env: frontendEnv,
  },
);

children.push(backend, frontend);
attachLifecycle(backend, "api");
attachLifecycle(frontend, "web");

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
