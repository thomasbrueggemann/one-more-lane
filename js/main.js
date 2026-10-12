import { App } from './app.js';

const app = new App();
window.__app = app; // handy for debugging in the console

// Offline support / installability: the service worker precaches the whole game.
// On localhost it stays off (cache-first workers get in the way of development) unless you add ?pwa to the URL.
if ('serviceWorker' in navigator) {
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const enable = location.protocol === 'https:' || (local && new URLSearchParams(location.search).has('pwa'));
  if (enable) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('./sw.js')
        .then((reg) => {
          reg.addEventListener('updatefound', () => {
            const nw = reg.installing;
            if (!nw) return;
            nw.addEventListener('statechange', () => {
              if (nw.state === 'installed' && navigator.serviceWorker.controller) {
                app.ui.toast('A new version is ready – reload to update', 'info', 6000);
              }
            });
          });
        })
        .catch(() => {});
    });
  } else if (local) {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
    if (window.caches) caches.keys().then((ks) => ks.filter((k) => k.startsWith('one-more-lane-')).forEach((k) => caches.delete(k)));
  }
}
