const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");

// ─── Load .env file in production (must happen before anything reads process.env) ───
function loadEnvFile() {
  const envPath = path.join(app.getPath("userData"), ".env");
  const fallbackPath = path.join(__dirname, "..", ".env");
  const target = fs.existsSync(envPath)
    ? envPath
    : fs.existsSync(fallbackPath)
      ? fallbackPath
      : null;
  if (!target) return;
  const lines = fs.readFileSync(target, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed
      .slice(eqIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

let mainWindow;
let backendProcess;

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
const BACKEND_PORT = process.env.PORT || 3001;

// ─── Window ───
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    icon: path.join(__dirname, "assets", "icon.png"),
    title: "Optimus — Invoice Automation",
    backgroundColor: "#f8fafc",
    show: false,
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  if (isDev) {
    mainWindow.loadURL("http://localhost:3000");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist-client/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ─── Backend server ───
function startBackendServer() {
  return new Promise((resolve, reject) => {
    const serverScript = isDev
      ? path.join(__dirname, "../server/_core/index.ts")
      : path.join(__dirname, "../dist-server/index.js");

    const command = isDev ? "tsx" : "node";
    const args = [serverScript];

    // Resolve Python path: prefer bundled python in resources, fallback to system
    let pythonPath = "python3";
    const bundledPython = path.join(
      process.resourcesPath || "",
      "python",
      "python.exe"
    );
    if (
      !isDev &&
      process.platform === "win32" &&
      fs.existsSync(bundledPython)
    ) {
      pythonPath = bundledPython;
    } else if (process.platform === "win32") {
      pythonPath = "python"; // Windows uses 'python' not 'python3'
    }

    backendProcess = spawn(command, args, {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        NODE_ENV: isDev ? "development" : "production",
        PORT: String(BACKEND_PORT),
        ELECTRON_MODE: "true",
        PYTHON_PATH: pythonPath,
        PYTHON_SCRIPTS_DIR: isDev
          ? path.join(__dirname, "../server/python")
          : path.join(__dirname, "../server/python"),
      },
      stdio: "pipe",
    });

    let resolved = false;
    const resolveOnce = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };

    // Resolve as soon as we see any output (server is alive)
    backendProcess.stdout.on("data", data => {
      const msg = data.toString().trim();
      console.log(`[Backend] ${msg}`);
      resolveOnce();
    });

    backendProcess.stderr.on("data", data => {
      console.error(`[Backend:err] ${data.toString().trim()}`);
      resolveOnce(); // stderr output also means process started
    });

    backendProcess.on("error", err => {
      console.error("[Backend] Spawn error:", err.message);
      reject(err);
    });

    backendProcess.on("exit", code => {
      console.log(`[Backend] Exited with code ${code}`);
      if (!resolved)
        reject(new Error(`Backend exited early with code ${code}`));
    });

    // Fallback: resolve after 4 seconds regardless
    setTimeout(resolveOnce, 4000);
  });
}

function stopBackendServer() {
  if (backendProcess) {
    console.log("[Backend] Stopping...");
    backendProcess.kill();
    backendProcess = null;
  }
}

// ─── App lifecycle ───
app.whenReady().then(async () => {
  if (!isDev) loadEnvFile();

  console.log("[Electron] Starting backend...");
  try {
    await startBackendServer();
    console.log("[Electron] Backend ready");
  } catch (err) {
    console.error("[Electron] Backend start error:", err);
    // Still show window — the app may show a config error screen
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopBackendServer();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => stopBackendServer());

// ─── IPC ───
ipcMain.handle("get-app-path", () => app.getPath("userData"));
ipcMain.handle("get-version", () => app.getVersion());
ipcMain.handle("get-backend-port", () => BACKEND_PORT);

ipcMain.handle("select-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "PDF Files", extensions: ["pdf"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const filePath = result.filePaths[0];
  return {
    path: filePath,
    name: path.basename(filePath),
    data: fs.readFileSync(filePath).toString("base64"),
  };
});

ipcMain.handle("open-env-file", async () => {
  const envPath = path.join(app.getPath("userData"), ".env");
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(
      envPath,
      [
        "# Optimus Invoice Automation — Configuration",
        "# Edit this file to configure your database and ERP settings",
        "",
        "DATABASE_URL=mysql://root:password@localhost:3306/invoice_automation",
        "JWT_SECRET=change-this-to-a-64-char-random-string",
        "NODE_ENV=production",
        "PORT=3001",
      ].join("\n")
    );
  }
  const { shell } = require("electron");
  shell.openPath(envPath);
  return envPath;
});

process.on("uncaughtException", err =>
  console.error("[Electron] Uncaught:", err)
);
process.on("unhandledRejection", reason =>
  console.error("[Electron] Rejection:", reason)
);
