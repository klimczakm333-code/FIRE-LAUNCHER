const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const { Auth } = require("msmc");
const { Client } = require("minecraft-launcher-core");
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const AdmZip = require("adm-zip");

// ============================================================
// POMOCNICZE FUNKCJE HTTP
// ============================================================

function getUrlBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) {
      return reject(new Error("Za dużo przekierowań HTTP."));
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

      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });

    req.on("error", reject);
  });
}

function downloadToFile(url, file, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) {
      return reject(new Error("Za dużo przekierowań podczas pobierania."));
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
        output.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
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

    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
    input.on("error", reject);
  });
}

// ============================================================
// LOGI
// ============================================================

function redactSecrets(message) {
  return String(message).replace(
    /(--accessToken\s+)\S+/gi,
    "$1[UKRYTO]"
  );
}

function writeLauncherLog(logFile, message) {
  const safeMessage = redactSecrets(message);

  console.log(safeMessage);

  if (logFile) {
    fs.appendFileSync(
      logFile,
      `[${new Date().toISOString()}] ${safeMessage}\n`,
      "utf8"
    );
  }
}

// ============================================================
// AUTOMATYCZNA JAVA
// ============================================================

function findJavaExecutable(folder, depth = 0) {
  if (!fs.existsSync(folder)) {
    return null;
  }

  if (!fs.statSync(folder).isDirectory()) {
    return null;
  }

  const candidates = [
    path.join(folder, "bin", "java.exe"),
    path.join(folder, "jre", "bin", "java.exe")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  if (depth >= 5) {
    return null;
  }

  for (const entry of fs.readdirSync(folder, {
    withFileTypes: true
  })) {
    if (entry.isDirectory()) {
      const found = findJavaExecutable(
        path.join(folder, entry.name),
        depth + 1
      );

      if (found) {
        return found;
      }
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

  const release = manifest.versions.find(
    (item) => item.id === String(version)
  );

  if (!release) {
    throw new Error(
      `Nie znaleziono oficjalnej wersji Minecrafta ${version}.`
    );
  }

  const metadata = JSON.parse(
    (await getUrlBuffer(release.url)).toString("utf8")
  );

  const metadataMajor = Number(metadata.javaVersion?.majorVersion);

  if (Number.isInteger(metadataMajor) && metadataMajor > 0) {
    return metadataMajor;
  }

  // Zapasowe wartości dla starszych wersji bez pola javaVersion.
  const match = String(version).match(/^1\.(\d+)(?:\.(\d+))?/);

  if (!match) {
    throw new Error(
      `Nie można ustalić wymaganej Javy dla wersji ${version}.`
    );
  }

  const minor = Number(match[1]);
  const patch = Number(match[2] || 0);

  if (minor <= 16) {
    return 8;
  }

  if (minor === 17) {
    return 16;
  }

  if (
    minor >= 18 &&
    minor <= 20 &&
    (minor < 20 || patch < 5)
  ) {
    return 17;
  }

  return 21;
}

async function getJavaPathForVersion(version) {
  const major = await getRequiredJavaMajor(version);

  const runtimeRoot = path.join(
    app.getPath("appData"),
    "FIRE LAUNCHER",
    "runtime"
  );

  const installDir = path.join(
    runtimeRoot,
    `java-${major}`
  );

  // Jeśli odpowiednia Java już jest pobrana, użyj jej.
  const existingJava = findJavaExecutable(installDir);

  if (existingJava) {
    console.log(`[JAVA] Używam Javy ${major}.`);
    return existingJava;
  }

  fs.mkdirSync(runtimeRoot, { recursive: true });

  const archive = path.join(
    runtimeRoot,
    `java-${major}.zip`
  );

  const stagingDir = path.join(
    runtimeRoot,
    `java-${major}-extract`
  );

  console.log(`[JAVA] Pobieram Javę ${major}...`);

  const apiUrl =
    `https://api.adoptium.net/v3/assets/latest/${major}/hotspot` +
    "?architecture=x64&image_type=jdk&os=windows&vendor=eclipse";

  try {
    const assets = JSON.parse(
      (await getUrlBuffer(apiUrl)).toString("utf8")
    );

    const asset = Array.isArray(assets)
      ? assets.find(
          (item) =>
            item?.binary?.package?.link &&
            item?.binary?.package?.checksum
        )
      : assets;

    const packageInfo = asset?.binary?.package;

    if (!packageInfo?.link || !packageInfo?.checksum) {
      throw new Error(
        `Nie znaleziono archiwum Javy ${major} lub sumy kontrolnej.`
      );
    }

    await downloadToFile(packageInfo.link, archive);

    const actualHash = await sha256File(archive);

    if (
      actualHash.toLowerCase() !==
      packageInfo.checksum.toLowerCase()
    ) {
      throw new Error(
        "Suma kontrolna pobranej Javy jest nieprawidłowa."
      );
    }

    fs.rmSync(stagingDir, {
      recursive: true,
      force: true
    });

    fs.mkdirSync(stagingDir, { recursive: true });

    new AdmZip(archive).extractAllTo(stagingDir, true);

    const extractedJava = findJavaExecutable(stagingDir);

    if (!extractedJava) {
      throw new Error(
        "W pobranym archiwum nie znaleziono java.exe."
      );
    }

    const relativeJavaPath = path.relative(
      stagingDir,
      extractedJava
    );

    fs.rmSync(installDir, {
      recursive: true,
      force: true
    });

    fs.renameSync(stagingDir, installDir);

    const javaPath = path.join(
      installDir,
      relativeJavaPath
    );

    if (!fs.existsSync(javaPath)) {
      throw new Error(
        "Nie udało się znaleźć Javy po rozpakowaniu."
      );
    }

    console.log(`[JAVA] Java ${major} jest gotowa.`);
    return javaPath;
  } finally {
    fs.rmSync(archive, { force: true });

    fs.rmSync(stagingDir, {
      recursive: true,
      force: true
    });
  }
}

// ============================================================
// ZAPAMIĘTYWANIE SESJI MICROSOFT
// ============================================================

function getSessionFile() {
  return path.join(
    app.getPath("userData"),
    "account.dat"
  );
}

async function saveLoginSession(xboxManager) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error(
      "Szyfrowanie sesji jest niedostępne."
    );
  }

  const encrypted = await safeStorage.encryptStringAsync(
    xboxManager.save()
  );

  const file = getSessionFile();

  fs.mkdirSync(path.dirname(file), {
    recursive: true
  });

  fs.writeFileSync(file, encrypted);
}

async function readLoginSession() {
  const file = getSessionFile();

  if (!fs.existsSync(file)) {
    return null;
  }

  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error(
      "Nie można odszyfrować zapisanej sesji."
    );
  }

  const encrypted = fs.readFileSync(file);

  const decrypted = await safeStorage.decryptStringAsync(
    encrypted
  );

  return decrypted.result;
}

// ============================================================
// OKNO LAUNCHERA I URUCHAMIANIE MINECRAFTA
// ============================================================

function createWindow() {
  const win = new BrowserWindow({
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    width: 1000,
    height: 650,
    title: "FIRE LAUNCHER",
    backgroundColor: "#101010",
    autoHideMenuBar: true
  });

  ipcMain.on(
    "launch-minecraft",
    async (event, version) => {
      const logDir = path.join(
        app.getPath("appData"),
        "FIRE LAUNCHER",
        "logs"
      );

      fs.mkdirSync(logDir, { recursive: true });

      const logFile = path.join(
        logDir,
        "launcher.log"
      );

      const log = (message) => {
        writeLauncherLog(logFile, message);
      };

      try {
        log(`Kliknięto PLAY. Wybrana wersja: ${version}`);

        if (!global.minecraftToken) {
          log("[ERROR] Brak tokenu Microsoft.");
          return;
        }

        const launcher = new Client();

        launcher.on("debug", (message) => {
          log(`[MCLC DEBUG] ${message}`);
        });

        launcher.on("data", (message) => {
          log(`[MCLC GAME] ${message}`);
        });

        launcher.on("close", (code) => {
          log(`[MCLC CLOSE] Kod: ${code}`);
        });

        // Automatycznie wybierz/pobierz Javę dla tej wersji.
        const javaPath = await getJavaPathForVersion(version);

        log("[JAVA] Środowisko Java jest gotowe.");

        const opts = {
          authorization: global.minecraftToken.mclc(),

          root: path.join(
  app.getPath("appData"),
  "FIRE LAUNCHER",
  String(version) === "1.15"
    ? ".minecraft-1.15-test"
    : ".minecraft"
),

          javaPath,

          version: {
            number: String(version),
            type: "release"
          }
        };

        log("[LAUNCHER] Rozpoczynam uruchamianie Minecrafta.");

        await launcher.launch(opts);

        log("[LAUNCHER] Wywołanie uruchamiania zakończone.");
      } catch (error) {
        log(
          `[ERROR] Uruchamianie Minecrafta nie powiodło się: ${
            error?.stack || error?.message || error
          }`
        );
      }
    }
  );

  win.loadFile(path.join(__dirname, "index.html"));
}

// ============================================================
// LOGOWANIE MICROSOFT
// ============================================================

ipcMain.on("microsoft-login", async (event) => {
  try {
    const authManager = new Auth("select_account");
    const xboxManager = await authManager.launch("raw");
    const token = await xboxManager.getMinecraft();

    global.minecraftToken = token;

    await saveLoginSession(xboxManager);

    event.sender.send("login-success");

    console.log("Logowanie Microsoft zakończone.");
    console.log(
      "Token Minecraft dostępny:",
      Boolean(global.minecraftToken)
    );
  } catch (error) {
    console.error(
      "Błąd logowania:",
      error?.message || error
    );
  }
});

ipcMain.on("check-login-session", async (event) => {
  try {
    const savedSession = await readLoginSession();

    if (!savedSession) {
      console.log("Brak zapisanej sesji Microsoft.");
      return;
    }

    const authManager = new Auth("select_account");
    const xboxManager = await authManager.refresh(savedSession);
    const token = await xboxManager.getMinecraft();

    global.minecraftToken = token;

    event.sender.send("login-success");

    console.log("Przywrócono sesję Microsoft.");
  } catch (error) {
    console.error(
      "Nie udało się przywrócić sesji:",
      error?.message || error
    );
  }
});

// ============================================================
// START APLIKACJI
// ============================================================

app.on("window-all-closed", () => {
  app.quit();
});

app.whenReady().then(createWindow);