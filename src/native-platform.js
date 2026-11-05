import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';

export const isNativeApp = () => Capacitor.isNativePlatform();

/** Native assets are part of the signed app, with no first-run model download. */
export function recognitionAssetOptions({ native = isNativeApp(), href = globalThis.location?.href } = {}) {
  if (!native) return {};
  const local = path => new URL(path, href).href;
  return {
    baseUrl: local('/models/'),
    quranUrl: local('/data/quran.json'),
    wasmPaths: {
      // The identical .js alias avoids platform-dependent .mjs MIME detection.
      mjs: local('/ort/ort-wasm-simd-threaded.js'),
      wasm: local('/ort/ort-wasm-simd-threaded.wasm'),
    },
  };
}

/** Call from the tap handler before awaiting model preparation or permission. */
export function unlockAudioContext(AudioContextClass = globalThis.AudioContext) {
  const context = new AudioContextClass();
  return { context, ready: context.resume() };
}

export function microphoneErrorMessage(error, native = isNativeApp()) {
  if (error?.name === 'NotAllowedError') return native
    ? 'Microphone access was not granted. Allow Iqri to use the microphone in Settings, then try again.'
    : 'Microphone access was not granted. Allow it in Safari or your browser’s site settings, then try again.';
  if (error?.name === 'NotFoundError') return 'No microphone was found. Connect one and try again.';
  if (['NotReadableError', 'AbortError'].includes(error?.name))
    return 'The microphone is unavailable. Close other apps using it, then tap Start reciting again.';
  return error?.message || 'The microphone could not start. Reopen Iqri and try again.';
}

/** Permission sheets may resign active; only real backgrounding cancels setup. */
export async function registerNativeLifecycle({ isListening, onPause }, { native = isNativeApp(), app = App } = {}) {
  if (!native) return async () => {};
  const pause = () => { Promise.resolve(onPause()).catch(() => {}); };
  const registrations = await Promise.allSettled([
    Promise.resolve().then(() => app.addListener('pause', pause)),
    Promise.resolve().then(() => app.addListener('appStateChange', ({ isActive }) => { if (!isActive && isListening()) pause(); })),
  ]);
  const handles = registrations.filter(value => value.status === 'fulfilled').map(value => value.value);
  return async () => { await Promise.allSettled(handles.map(handle => handle.remove())); };
}
