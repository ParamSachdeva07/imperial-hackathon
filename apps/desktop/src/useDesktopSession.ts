import { useEffect, useState } from 'react';
import { type ApiResult, type ControllerState, type Health } from '../../../packages/contracts/src/index';

export function useDesktopSession() {
  const [state, setState] = useState<ControllerState | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function refreshHealth() {
    try {
      const result = await window.desktop.health();
      if (result.ok) setHealth(result.data);
      else setError(result.error);
    } catch (error) {
      setError(String(error));
    }
  }
  useEffect(() => {
    if (!window.desktop) {
      setError('Open Desktop Assistant with its Electron launcher.');
      return;
    }
    const unsubscribe = window.desktop.onState(setState);
    void window.desktop.state().then((current) => {
      if (!current.ok) throw new Error(current.error);
      setState(current.data);
      setReady(true);
    }).catch((error) => setError(error.message));
    void refreshHealth();
    return unsubscribe;
  }, []);
  async function command<T>(action: () => Promise<ApiResult<T>>) {
    setError('');
    setPending(true);
    try {
      const result = await action();
      if (!result.ok) setError(result.error);
      return result.ok;
    } catch (error) {
      setError(String(error));
      return false;
    } finally {
      setPending(false);
    }
  }
  const backend = health?.backend;
  const modelsConfigured = !!backend?.navigatorConfigured && !!backend.orchestratorConfigured;
  const connected = !!health?.native.available && health.native.accessibility === 'granted' && !!backend?.available && modelsConfigured;
  // Permissions and keys are changed outside the app. Notice the change without a manual check.
  useEffect(() => {
    if (connected || !window.desktop) return;
    const timer = setInterval(() => void refreshHealth(), 3000);
    const onFocus = () => void refreshHealth();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [connected]);
  const waiting = state?.status === 'needs_user' && !state.busy;
  return {
    state, health, ready, pending, connected, modelsConfigured, error, waiting,
    busy: !!state?.busy || pending,
    /** A new instruction replaces whatever is running. */
    run: (goal: string) => command(() => (state?.busy || waiting ? window.desktop.replace : window.desktop.start)({ goal })),
    answer: (text: string) => command(() => window.desktop.answer(text)),
    refreshHealth,
    stop: () => command(() => window.desktop.cancel()),
    openPermissions: () => command(() => window.desktop.openAccessibilitySettings()),
  };
}
