
const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  const playButton = document.querySelector("#play");
  const loginButton = document.querySelector("#login");
  const versionSelect = document.querySelector("#version");
  const status = document.querySelector("#status");

  function setStatus(message) {
    if (status) status.textContent = message;
  }

  // PLAY — uruchamianie Minecrafta
  if (playButton) {
    playButton.addEventListener("click", () => {
      const version = versionSelect?.value;

      if (!version) {
        setStatus("Wybierz wersję Minecrafta.");
        return;
      }

      playButton.disabled = true;
      setStatus(`Uruchamianie Minecrafta ${version}...`);
      ipcRenderer.send("launch-minecraft", version);
    });
  }

  // Logowanie Microsoft
  if (loginButton) {
    loginButton.addEventListener("click", () => {
      loginButton.disabled = true;
      setStatus("Otwieranie logowania Microsoft...");
      ipcRenderer.send("microsoft-login");
    });
  }

  // Wynik logowania lub przywrócenia sesji
  ipcRenderer.on("login-success", () => {
    if (loginButton) {
      loginButton.disabled = true;
      loginButton.textContent = "Zalogowano przez Microsoft";
    }

    setStatus("Konto Microsoft połączone. Możesz grać!");
  });

  ipcRenderer.on("login-error", (_event, message) => {
    if (loginButton) loginButton.disabled = false;
    setStatus("Błąd logowania: " + message);
  });

  ipcRenderer.on("login-session-missing", () => {
    if (loginButton) loginButton.disabled = false;
    setStatus("Zaloguj się przez Microsoft, aby rozpocząć grę.");
  });

  ipcRenderer.on("login-session-error", (_event, message) => {
    if (loginButton) loginButton.disabled = false;
    setStatus("Błąd przywracania sesji: " + message);
  });

  // Wynik uruchamiania Minecrafta
  ipcRenderer.on("minecraft-launch-error", (_event, message) => {
    if (playButton) playButton.disabled = false;
    setStatus("Błąd Minecrafta: " + message);
  });

  ipcRenderer.on("minecraft-launch-started", () => {
    if (playButton) playButton.disabled = false;
    setStatus("Wysłano polecenie uruchomienia Minecrafta.");
  });

  // Pobieranie oficjalnych wersji Minecrafta
  async function loadVersions() {
    if (!versionSelect) return;

    const previousVersion = versionSelect.value;

    try {
      const response = await fetch(
        "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
      );

      if (!response.ok) {
        throw new Error("Nie udało się pobrać listy wersji.");
      }

      const manifest = await response.json();
      const releases = manifest.versions.filter(
        version => version.type === "release"
      );

      versionSelect.replaceChildren();

      for (const release of releases) {
        const option = document.createElement("option");
        option.value = release.id;
        option.textContent =
          release.id +
          (release.id === manifest.latest.release ? " (najnowsza)" : "");

        versionSelect.appendChild(option);
      }

      if (releases.some(version => version.id === previousVersion)) {
        versionSelect.value = previousVersion;
      } else {
        versionSelect.value = manifest.latest.release;
      }

      console.log("Pobrano oficjalne wersje Minecrafta:", releases.length);
      setStatus("Gotowy do gry!");
    } catch (error) {
      console.error("Błąd pobierania wersji:", error);
      setStatus("Nie udało się pobrać listy wersji Minecrafta.");
    }
  }

  // Najpierw instalujemy obsługę zdarzeń, a dopiero potem sprawdzamy sesję.
  setStatus("Sprawdzanie konta Microsoft...");
  ipcRenderer.send("check-login-session");

  loadVersions();
});
