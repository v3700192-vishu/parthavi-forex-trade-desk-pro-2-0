'use strict';

(() => {
  const installButton = document.getElementById('installAppButton');
  let deferredInstallPrompt = null;

  function appIsInstalled() {
    return window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
  }

  if (installButton && !appIsInstalled()) {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      installButton.hidden = false;
    });

    installButton.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      const promptEvent = deferredInstallPrompt;
      deferredInstallPrompt = null;
      try {
        await promptEvent.prompt();
        const choice = await promptEvent.userChoice;
        if (choice && choice.outcome === 'accepted') {
          installButton.hidden = true;
        }
      } catch (_) {
        // Browser-level install UI may be unavailable or dismissed.
      }
    });
  }

  window.addEventListener('appinstalled', () => {
    if (installButton) installButton.hidden = true;
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
        // The dashboard remains usable online if offline-shell registration fails.
      });
    });
  }
})();
