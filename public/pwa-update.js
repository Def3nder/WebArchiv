/* WebArchiv — kontrollierte Aktualisierung installierter Web-Apps */
(function installPwaUpdater() {
  'use strict';

  const notice = document.getElementById('pwa-update-notice');
  const updateButton = document.getElementById('pwa-update-button');
  const dismissButton = document.getElementById('pwa-update-dismiss');
  const updateMessage = notice?.querySelector('.pwa-update-copy span');
  if (!notice || !updateButton || !dismissButton || !('serviceWorker' in navigator)) return;

  const CHECK_INTERVAL_MS = 15 * 60 * 1000;
  const CHECK_COOLDOWN_MS = 60 * 1000;
  let registration = null;
  let waitingWorker = null;
  let applyingUpdate = false;
  let lastCheck = 0;
  let reloadTimer = null;

  const updateDismissed = () => {
    try { return sessionStorage.getItem('wa-pwa-update-dismissed') === '1'; }
    catch { return false; }
  };

  const rememberDismissal = () => {
    try { sessionStorage.setItem('wa-pwa-update-dismissed', '1'); }
    catch { /* Private Browsermodi können Webspeicher sperren. */ }
  };

  const cleanUpdateParameter = () => {
    const url = new URL(location.href);
    if (!url.searchParams.has('app-update')) return;
    url.searchParams.delete('app-update');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  };

  const reloadFresh = () => {
    const url = new URL(location.href);
    url.searchParams.set('app-update', Date.now().toString(36));
    location.replace(url.href);
  };

  const showUpdate = worker => {
    if (!worker || updateDismissed()) return;
    waitingWorker = worker;
    notice.hidden = false;
  };

  const observeInstallingWorker = worker => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdate(worker);
    });
  };

  const checkForUpdate = async force => {
    if (!registration || (!force && Date.now() - lastCheck < CHECK_COOLDOWN_MS)) return;
    lastCheck = Date.now();
    try {
      await registration.update();
      if (registration.waiting) showUpdate(registration.waiting);
    } catch {
      // Offline oder vorübergehend nicht erreichbar: beim nächsten Aktivieren erneut prüfen.
    }
  };

  cleanUpdateParameter();

  window.addEventListener('load', async () => {
    try {
      registration = await navigator.serviceWorker.register('/service-worker.js', {
        scope: '/',
        updateViaCache: 'none',
      });
      if (registration.waiting && navigator.serviceWorker.controller) showUpdate(registration.waiting);
      registration.addEventListener('updatefound', () => observeInstallingWorker(registration.installing));
      await checkForUpdate(true);
      window.setInterval(() => checkForUpdate(false), CHECK_INTERVAL_MS);
    } catch {
      // Die App bleibt vollständig nutzbar, wenn Service Worker nicht verfügbar sind.
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate(false);
  });
  window.addEventListener('online', () => checkForUpdate(true));

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!applyingUpdate) return;
    applyingUpdate = false;
    window.clearTimeout(reloadTimer);
    reloadFresh();
  });

  updateButton.addEventListener('click', () => {
    if (!waitingWorker || applyingUpdate) return;
    if (document.querySelector('dialog[open]')) {
      if (updateMessage) updateMessage.textContent = 'Bitte zuerst den geöffneten Dialog schließen.';
      return;
    }
    applyingUpdate = true;
    updateButton.disabled = true;
    updateButton.textContent = 'Aktualisiere …';
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    reloadTimer = window.setTimeout(reloadFresh, 2500);
  });

  dismissButton.addEventListener('click', () => {
    notice.hidden = true;
    rememberDismissal();
  });
}());

// Die Versionssignatur des Workers berücksichtigt diese Datei automatisch.
