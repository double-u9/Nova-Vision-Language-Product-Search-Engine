import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findSystemPython,
  getRequirementsStampPath,
  getVenvPythonPath,
  loadProjectEnv,
  projectRoot,
  requirementsHash,
  runOrThrow,
} from "./shared.mjs";

export function ensurePythonEnvironment() {
  loadProjectEnv();

  const existingVenvPython = getVenvPythonPath();

  if (!existingVenvPython) {
    const systemPython = findSystemPython();

    if (!systemPython) {
      throw new Error(
        "Python 3.11 or 3.12 was not found. Install one of those versions or set NOVA_PYTHON in .env.",
      );
    }

    console.log(
      `[python] creating virtual environment with ${systemPython.command} ${systemPython.args.join(" ")}`.trim(),
    );
    runOrThrow(systemPython.command, [...systemPython.args, "-m", "venv", ".venv"]);
  }

  const venvPython = getVenvPythonPath();

  if (!venvPython) {
    throw new Error("The Python virtual environment was not created successfully.");
  }

  const stampPath = getRequirementsStampPath();
  const nextHash = requirementsHash();
  const currentHash = fs.existsSync(stampPath)
    ? fs.readFileSync(stampPath, "utf8").trim()
    : "";

  if (currentHash === nextHash) {
    console.log("[python] requirements already up to date");
    return venvPython;
  }

  const env = {
    ...process.env,
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
  };

  console.log("[python] upgrading pip tooling");
  runOrThrow(
    venvPython,
    ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"],
    { env },
  );

  console.log("[python] installing backend requirements");
  runOrThrow(venvPython, ["-m", "pip", "install", "-r", path.join(projectRoot, "requirements.txt")], {
    env,
  });

  fs.writeFileSync(stampPath, nextHash);

  return venvPython;
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  try {
    ensurePythonEnvironment();
  } catch (error) {
    console.error(
      `[python] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
