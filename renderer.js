const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  const playButton = document.querySelector('#play');
  const versionSelect = document.querySelector('#version');

  if (playButton) {
    playButton.addEventListener('click', () => {
      const version = versionSelect ? versionSelect.value : '1.8.9';

      ipcRenderer.send('launch-minecraft', version);
    });
  }
});
const loginButton = document.querySelector('#login');

if (loginButton) {
  loginButton.addEventListener('click', () => {
    ipcRenderer.send('microsoft-login');
  });
}
ipcRenderer.on('login-success', () => {
  const loginButton = document.querySelector('#login');

  if (loginButton) {
    loginButton.style.display = 'none';
  }
});

ipcRenderer.send('check-login-session');
window.addEventListener('DOMContentLoaded', async () => {
  const versionSelect = document.querySelector('#version');

  if (!versionSelect) {
    console.error('Nie znaleziono listy wersji Minecrafta.');
    return;
  }

  const previousVersion = versionSelect.value;

  try {
    const response = await fetch(
      'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
    );

    if (!response.ok) {
      throw new Error('Nie udało się pobrać listy wersji.');
    }

    const manifest = await response.json();
    const releases = manifest.versions.filter(
      version => version.type === 'release'
    );

    versionSelect.replaceChildren();

    for (const release of releases) {
      const option = document.createElement('option');
      option.value = release.id;
      option.textContent =
        release.id +
        (release.id === manifest.latest.release ? ' (najnowsza)' : '');

      versionSelect.appendChild(option);
    }

    if (releases.some(version => version.id === previousVersion)) {
      versionSelect.value = previousVersion;
    } else {
      versionSelect.value = manifest.latest.release;
    }

    console.log('Pobrano oficjalne wersje Minecrafta:', releases.length);
  } catch (error) {
    console.error('Błąd pobierania wersji:', error);
  }
});