import { isNativeApp } from './native-platform.js';

/** Register the app worker and make one safe, pre-microphone isolation reload. */
export async function prepareBrowserAcceleration({ native = isNativeApp() } = {}) {
  if (native) return false;
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return false;
  let registration;
  try { registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }); }
  catch { return false; }
  if (window.crossOriginIsolated) return false;
  const flag = 'iqri:acceleration-reload:v4';
  try { if (sessionStorage.getItem(flag)) return false; } catch { return false; }
  const capabilities = worker => new Promise(resolve => {
    if (!worker) return resolve(null);
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, 300);
    channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); resolve(data); };
    worker.postMessage({ type: 'iqri-capabilities' }, [channel.port2]);
  });
  const deadline = performance.now() + 2500;
  while (performance.now() < deadline) {
    const capability = await capabilities(navigator.serviceWorker.controller);
    if (capability?.isolation === true) {
      try { sessionStorage.setItem(flag, '1'); } catch { return false; }
      // Runs before app initialization, so a live microphone is never interrupted.
      window.location.reload();
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}
