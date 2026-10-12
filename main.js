
const {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  dialog
} = require("electron");

const { Auth } = require("msmc");
const { Client } = require("minecraft-launcher-core");
const { autoUpdater } = require("electron-updater");

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const AdmZip = require("adm-zip");

let mainWindow = null;
let launchingMinecraft = false;

// ============================================================
// HTTP
// ============================================================

function getUrlBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) {
      reject(new Error("Za dużo przekierowań HTTP."));
      return;
    }

    const req = https.get(url, (res) => {
      if (
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location
      ) {
        res.resume();
        getUrlBuffer(
          new URL(res.headers.location, url).toString(),
          redirects + 1
        ).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Błąd HTTP ${res.statusCode}.`));
        return;
      }

      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });

    req.on("error", reject);
  });
}

function downloadToFile(url, file, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) {
      reject(new Error("Za dużo przekierowań podczas pobierania."));
      return;
    }

    const req = https.get(url, (res) => {
      if (
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location
      ) {
        res.resume();
        downloadToFile(
          new URL(res.headers.location, url).toString(),
          file,
          redirects + 1
        ).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Pobieranie nieudane: HTTP ${res.statusCode}.`));
        return;
      }

      const output = fs.createWriteStream(file);

      output.on("error", reject);
      res.on("error", reject);

      output.on("finish", () => {
        output.close(error => error ? reject(error) : resolve());
      });

      res.pipe(output);
    });

    req.on("error", reject);
  });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const input = fs.createReadStream(file);

    input.on("data", chunk => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
    input.on("error", reject);
  });
}

// ============================================================
// LOGI
// ============================================================

function getLogFile() {
  const dir = path.join(
    app.getPath("appData"),
    "FIRE LAUNCHER",
    "logs"
  );

  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "launcher.log");
}

function log(message) {
  const safeMessage = String(message).replace(
    /(--accessToken\s+)\S+/gi,
    "$1[UKRYTO]"
  );

  console.log(safeMessage);

  try {
    fs.appendFileSync(
      getLogFile(),
      `[${new Date().toISOString()}] ${safeMessage}\n`,
      "utf8"
    );
  } catch (error) {
    console.error("[LOG] Nie udało się zapisać logu:", error.message);
  }
}

function sendToWindow(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

// ============================================================
// JAVA
// ============================================================

function findJavaExecutable(folder, depth = 0) {
  if (!fs.existsSync(folder)) return null;

  let stats;

  try {
    stats = fs.statSync(folder);
  } catch {
    return null;
  }

  if (!stats.isDirectory()) return null;

  const candidates = [
    path.join(folder, "bin", "java.exe"),
    path.join(folder, "jre", "bin", "java.exe")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  if (depth >= 5) return null;

  let entries;

  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findJavaExecutable(
        path.join(folder, entry.name),
        depth + 1
      );

      if (found) return found;
    }
  }

  return null;
}

async function getRequiredJavaMajor(version) {
  const manifestUrl =
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

  const manifest = JSON.parse(
    (await getUrlBuffer(manifestUrl)).toString("utf8")
  );

  const release = manifest.versions.find(item => item.id === version);

  if (!release) {
    throw new Error(`Nie znaleziono wersji Minecrafta ${version}.`);
  }

  const metadata = JSON.parse(
    (await getUrlBuffer(release.url)).toString("utf8")
  );

  const major = Number(metadata.javaVersion?.majorVersion);

  if (Number.isInteger(major) && major > 0) return major;

  const match = version.match(/^1\.(\d+)(?:\.(\d+))?/);

  if (!match) {
    throw new Error(`Nie można ustalić wymaganej Javy dla ${version}.`);
  }

  const minor = Number(match[1]);
  const patch = Number(match[2] || 0);

  if (minor <= 16) return 8;
  if (minor === 17) return 16;
  if (minor >= 18 && minor < 20) return 17;
  if (minor === 20 && patch < 5) return 17;

  return 21;
}

async function getJavaPathForVersion(version) {
  const major = await getRequiredJavaMajor(version);

  const runtimeRoot = path.join(
    app.getPath("appData"),
    "FIRE LAUNCHER",
    "runtime"
  );

  const installDir = path.join(runtimeRoot, `java-${major}`);
  const existingJava = findJavaExecutable(installDir);

  if (existingJava) {
    log(`[JAVA] Używam Javy ${major}.`);
    return existingJava;
  }

  fs.mkdirSync(runtimeRoot, { recursive: true });

  const archive = path.join(runtimeRoot, `java-${major}.zip`);
  const stagingDir = path.join(runtimeRoot, `java-${major}-extract`);

  log(`[JAVA] Pobieram Javę ${major}...`);

  const apiUrl =
    `https://api.adoptium.net/v3/assets/latest/${major}/hotspot` +
    "?architecture=x64&image_type=jdk&os=windows&vendor=eclipse";

  try {
    const assets = JSON.parse(
      (await getUrlBuffer(apiUrl)).toString("utf8")
    );

    const asset = Array.isArray(assets)
      ? assets.find(item =>
          item?.binary?.package?.link &&
          item?.binary?.package?.checksum
        )
      : assets;

    const packageInfo = asset?.binary?.package;

    if (!packageInfo?.link || !packageInfo?.checksum) {
      throw new Error(`Nie znaleziono archiwum Javy ${major}.`);
    }

    await downloadToFile(packageInfo.link, archive);

    const actualHash = await sha256File(archive);

    if (actualHash.toLowerCase() !== packageInfo.checksum.toLowerCase()) {
      throw new Error("Suma kontrolna pobranej Javy jest nieprawidłowa.");
    }

    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });

    new AdmZip(archive).extractAllTo(stagingDir, true);

    const extractedJava = findJavaExecutable(stagingDir);

    if (!extractedJava) {
      throw new Error("W archiwum nie znaleziono java.exe.");
    }

    const relativeJavaPath = path.relative(stagingDir, extractedJava);

    fs.rmSync(installDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, installDir);

    const javaPath = path.join(installDir, relativeJavaPath);

    if (!fs.existsSync(javaPath)) {
      throw new Error("Nie znaleziono Javy po rozpakowaniu.");
    }

    log(`[JAVA] Java ${major} jest gotowa.`);
    return javaPath;
  } finally {
    fs.rmSync(archive, { force: true });
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

// ============================================================
// SESJA MICROSOFT
// ============================================================

function getSessionFile() {
  return path.join(app.getPath("userData"), "account.dat");
}

function saveLoginSession(xboxManager) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Szyfrowanie sesji jest niedostępne.");
  }

  const session = xboxManager.save();
  const encrypted = safeStorage.encryptString(session);
  const file = getSessionFile();

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encrypted);
}

function readLoginSession() {
  const file = getSessionFile();

  if (!fs.existsSync(file)) return null;

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Nie można odszyfrować zapisanej sesji.");
  }

  return safeStorage.decryptString(fs.readFileSync(file));
}

// ============================================================
// OKNO
// ============================================================

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 650,
    title: "FIRE LAUNCHER",
    backgroundColor: "#101010",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

// ============================================================
// LOGOWANIE
// ============================================================

ipcMain.on("microsoft-login", async event => {
  try {
    const authManager = new Auth("select_account");
    const xboxManager = await authManager.launch("raw");
    const token = await xboxManager.getMinecraft();

    global.minecraftToken = token;

    saveLoginSession(xboxManager);

    event.sender.send("login-success");
    log("[LOGIN] Zalogowano przez Microsoft i zapisano sesję.");
  } catch (error) {
    log(`[LOGIN] Błąd: ${error?.stack || error?.message || error}`);

    try {
      event.sender.send(
        "login-error",
        error?.message || "Logowanie Microsoft nie powiodło się."
      );
    } catch {}
  }
});

ipcMain.on("check-login-session", async event => {
  try {
    const savedSession = readLoginSession();

    if (!savedSession) {
      log("[LOGIN] Brak zapisanej sesji.");
      event.sender.send("login-session-missing");
      return;
    }

    const authManager = new Auth("select_account");
    const xboxManager = await authManager.refresh(savedSession);
    const token = await xboxManager.getMinecraft();

    global.minecraftToken = token;

    // Zapisz odświeżoną sesję.
    saveLoginSession(xboxManager);

    event.sender.send("login-success");
    log("[LOGIN] Przywrócono sesję Microsoft.");
  } catch (error) {
    log(`[LOGIN] Przywracanie sesji nie powiodło się: ${error?.stack || error?.message || error}`);

    try {
      event.sender.send(
        "login-session-error",
        error?.message || "Nie udało się przywrócić sesji."
      );
    } catch {}
  }
});

// ============================================================
// URUCHAMIANIE MINECRAFTA
// ============================================================

ipcMain.on("launch-minecraft", async (event, requestedVersion) => {
  if (launchingMinecraft) {
    event.sender.send("minecraft-launch-error", "Minecraft już się uruchamia.");
    return;
  }

  launchingMinecraft = true;

  try {
    if (!["string", "number"].includes(typeof requestedVersion)) {
      throw new Error("Nieprawidłowa wersja Minecrafta.");
    }

    const version = String(requestedVersion).trim();

    if (!version) throw new Error("Nie wybrano wersji Minecrafta.");

    if (!global.minecraftToken) {
      throw new Error("Najpierw zaloguj się przez Microsoft.");
    }

    log(`[LAUNCH] Uruchamiam Minecraft ${version}...`);

    const javaPath = await getJavaPathForVersion(version);

    const launcher = new Client();

    launcher.on("debug", message => log(`[MCLC DEBUG] ${message}`));
    launcher.on("data", message => log(`[MCLC GAME] ${message}`));
    launcher.on("close", code => log(`[MCLC CLOSE] Kod: ${code}`));

    const minecraftRoot = path.join(
      app.getPath("appData"),
      "FIRE LAUNCHER",
      version === "1.15" ? ".minecraft-1.15-test" : ".minecraft"
    );


const opts = {
  authorization: global.minecraftToken.mclc(),
  root: minecraftRoot,
  javaPath,
  memory: {
    min: "256M",
    max: "512M"
  },
  version: {
    number: version,
    type: "release"
  }
};


    await launcher.launch(opts);

    log(`[LAUNCH] Wysłano polecenie uruchomienia wersji ${version}.`);
    event.sender.send("minecraft-launch-started");
  } catch (error) {
    const message = error?.message || "Nie udało się uruchomić Minecrafta.";

    log(`[LAUNCH] Błąd: ${error?.stack || message}`);

    try {
      event.sender.send("minecraft-launch-error", message);
    } catch {}
  } finally {
    launchingMinecraft = false;
  }
});

// ============================================================
// AKTUALIZACJE
// ============================================================

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on("checking-for-update", () => {
  log("[UPDATE] Sprawdzam aktualizacje...");
});

autoUpdater.on("update-available", info => {
  log(`[UPDATE] Dostępna wersja ${info.version}. Pobieranie...`);
});

autoUpdater.on("update-not-available", () => {
  log("[UPDATE] Launcher jest aktualny.");
});

autoUpdater.on("download-progress", progress => {
  log(`[UPDATE] Pobieranie: ${Math.round(progress.percent)}%`);
});

autoUpdater.on("update-downloaded", async info => {
  try {
    const result = await dialog.showMessageBox({
      type: "info",
      title: "FIRE LAUNCHER — aktualizacja",
      message: `Wersja ${info.version} jest gotowa do instalacji.`,
      detail: "Uruchom launcher ponownie, aby dokończyć aktualizację.",
      buttons: ["Uruchom ponownie", "Później"],
      defaultId: 0,
      cancelId: 1
    });

    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  } catch (error) {
    log(`[UPDATE] Błąd: ${error.message}`);
  }
});

autoUpdater.on("error", error => {
  log(`[UPDATE] Błąd aktualizacji: ${error.message}`);
});

// ============================================================
// START
// ============================================================

app.on("window-all-closed", () => {
  app.quit();
});

app.whenReady().then(() => {
  createWindow();

  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(error => {
        log(`[UPDATE] Nie udało się sprawdzić aktualizacji: ${error.message}`);
      });
    }, 3000);
  }
});
