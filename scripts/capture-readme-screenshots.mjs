import { spawn } from "node:child_process";
import { mkdir, writeFile, access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCREENSHOT_DIR = path.join(ROOT, "docs", "screenshots");
const DEBUG_PORT = 9222;
const APP_URL = "http://127.0.0.1:3000/";
const CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const RED_SHIRT_IMAGE = path.join(
  ROOT,
  "nova",
  "data",
  "fashionIQ_dataset",
  "images",
  "B007KPH08S.jpg",
);
const PROFILE_DIR = path.join(
  ROOT,
  ".tmp",
  `chrome-readme-profile-${Date.now()}`,
);

let nextCommandId = 0;

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveChromePath() {
  for (const candidate of CHROME_PATHS) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Chrome or Edge was not found. Update CHROME_PATHS in capture-readme-screenshots.mjs.",
  );
}

async function waitForDebugger() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        if (Array.isArray(targets) && targets.length > 0) {
          return targets;
        }
      }
    } catch {}

    await delay(500);
  }

  throw new Error("Timed out waiting for Chrome remote debugging to start.");
}

async function connectToPage(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let pageReady = false;

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", reject);
  });

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(String(event.data));

    if (payload.id) {
      const deferred = pending.get(payload.id);
      if (!deferred) return;
      pending.delete(payload.id);
      if (payload.error) deferred.reject(new Error(payload.error.message));
      else deferred.resolve(payload.result ?? {});
      return;
    }

    if (payload.method === "Page.loadEventFired") {
      pageReady = true;
    }
  });

  function send(method, params = {}) {
    const id = ++nextCommandId;
    const message = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(message);
    });
  }

  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result.result?.value;
  }

  async function waitFor(testExpression, label, timeoutMs = 20000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await evaluate(testExpression)) {
        return;
      }
      await delay(250);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async function click(selector) {
    const clicked = await evaluate(`
      (() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return false;
        node.click();
        return true;
      })()
    `);
    if (!clicked) {
      throw new Error(`Could not click selector: ${selector}`);
    }
  }

  async function fill(selector, value) {
    const updated = await evaluate(`
      (() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return false;
        node.focus();
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
        valueSetter?.call(node, ${JSON.stringify(value)});
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
    if (!updated) {
      throw new Error(`Could not fill selector: ${selector}`);
    }
  }

  async function setRange(selector, value) {
    const updated = await evaluate(`
      (() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return false;
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
        valueSetter?.call(node, ${JSON.stringify(String(value))});
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
    if (!updated) {
      throw new Error(`Could not update slider: ${selector}`);
    }
  }

  async function setFileInput(selector, filePath) {
    const { root: { nodeId: rootNodeId } } = await send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const { nodeId } = await send("DOM.querySelector", {
      nodeId: rootNodeId,
      selector,
    });
    if (!nodeId) {
      throw new Error(`Could not find file input: ${selector}`);
    }
    await send("DOM.setFileInputFiles", {
      nodeId,
      files: [filePath],
    });
  }

  async function captureScreenshot(outputPath, clip) {
    const result = await send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      ...(clip
        ? {
            clip: {
              ...clip,
              scale: 1,
            },
          }
        : {}),
    });
    await writeFile(outputPath, Buffer.from(result.data, "base64"));
  }

  async function navigate(url) {
    pageReady = false;
    await send("Page.navigate", { url });
    await waitFor("document.readyState === 'complete'", `page load for ${url}`);
    if (!pageReady) {
      await delay(500);
    }
  }

  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });

  return {
    socket,
    send,
    evaluate,
    waitFor,
    click,
    fill,
    setRange,
    setFileInput,
    captureScreenshot,
    navigate,
  };
}

async function main() {
  await mkdir(SCREENSHOT_DIR, { recursive: true });

  const chromePath = await resolveChromePath();
  const browser = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      "--window-size=1600,1000",
      "about:blank",
    ],
    {
      stdio: "ignore",
      detached: false,
    },
  );

  try {
    const targets = await waitForDebugger();
    const pageTarget =
      targets.find((target) => target.type === "page") ?? targets[0];

    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error("Could not find a debuggable page target.");
    }

    const page = await connectToPage(pageTarget.webSocketDebuggerUrl);

    await page.navigate(APP_URL);
    await page.waitFor(
      "Boolean(document.querySelector('[data-testid=\"search-bar\"]'))",
      "the search bar",
    );
    await page.evaluate("window.scrollTo(0, 0)");
    await delay(1000);
    await page.captureScreenshot(path.join(SCREENSHOT_DIR, "hero-home.png"), {
      x: 0,
      y: 0,
      width: 1600,
      height: 1000,
    });

    await page.setFileInput('input[type=\"file\"]', RED_SHIRT_IMAGE);
    await page.waitFor(
      "Boolean(document.querySelector('[data-testid=\"button-remove-image\"]'))",
      "the image preview",
    );
    await page.fill('[data-testid=\"input-search\"]', "Red T-Shirt");
    await page.waitFor(
      "Boolean(document.querySelector('[data-testid=\"slider-alpha\"]'))",
      "the hybrid blend slider",
    );
    await page.setRange('[data-testid=\"slider-alpha\"]', 0.45);
    await page.click('[data-testid=\"button-search\"]');
    await page.waitFor(
      "Boolean(document.querySelector('[data-testid=\"results-grid\"]'))",
      "search results",
      30000,
    );
    await page.evaluate("window.scrollTo(0, 0)");
    await delay(1200);
    await page.captureScreenshot(
      path.join(SCREENSHOT_DIR, "hybrid-red-shirt.png"),
      {
        x: 80,
        y: 0,
        width: 1440,
        height: 980,
      },
    );

    await page.click('[data-testid=\"button-open-drawer\"]');
    await page.waitFor(
      "Boolean(document.querySelector('[data-testid=\"drawer-insight\"]'))",
      "the insight drawer",
      10000,
    );
    await delay(500);
    await page.captureScreenshot(
      path.join(SCREENSHOT_DIR, "insight-drawer.png"),
      {
        x: 520,
        y: 0,
        width: 1080,
        height: 980,
      },
    );

    page.socket.close();
  } finally {
    browser.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
