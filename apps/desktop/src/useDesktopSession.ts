import { useEffect, useState } from 'react';
import { type ApiResult, type ControllerState, type Health } from '../../../packages/contracts/src/index';

export function useDesktopSession() {
  const [state, setState] = useState<ControllerState | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [maxSteps, setMaxSteps] = useState(160);
  const [supervisorEvery, setSupervisorEvery] = useState(12);

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
    void window.desktop
      .state()
      .then((current) => {
        if (!current.ok) throw new Error(current.error);
        setState(current.data);
        setReady(true);
      })
      .catch((error) => setError(error.message));
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
  const busy = !!state?.busy || pending;
  const connected =
    !!health?.native.available &&
    health.native.accessibility === 'granted' &&
    !!health.backend.available &&
    health.backend.keyConfigured && !!health.backend.supervisorConfigured;
  const run = (goal: string) =>
    command(() =>
      (state?.busy || state?.status === 'paused' ? window.desktop.replace : window.desktop.start)(
            {
              goal,
              mode: 'desktop',
              provider: 'jev',
              text: '',
              app: '',
              allowPhysical: false,
              maxSteps,
              supervisorEnabled: true,
              supervisorEvery,
              inputs: [],
            },
            false,
          ),
    );
  return {
    state,
    health,
    ready,
    busy,
    pending,
    connected,
    error,
    run,
    maxSteps, setMaxSteps,
    supervisorEvery, setSupervisorEvery,
    refreshHealth,
    stop: () => command(() => window.desktop.cancel()),
    openPermissions: () => command(() => window.desktop.openAccessibilitySettings()),
  };
}
