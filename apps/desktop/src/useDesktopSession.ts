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
  const [controller, setController] = useState<'v1' | 'v2'>('v2');
  const [grounding, setGrounding] = useState<'planner' | 'jev'>('planner');

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
  const run = (goal: string) =>
    command(() => waiting ? window.desktop.answer(goal) :
      (state?.busy || state?.status === 'paused' ? window.desktop.replace : window.desktop.start)(
            {
              goal,
              mode: 'desktop',
              provider: 'jev',
              text: '',
              app: '',
              allowPhysical: false,
              // Applies to standalone controllers; orchestration renews its bounded sessions.
              maxSteps,
              supervisorEnabled: true,
              supervisorEvery,
              inputs: [],
              // Only sent for the new controller, so the default request is unchanged.
              ...(controller === 'v2' ? { controller, grounding, orchestration: true, confirmIrreversible: true } : {}),
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
    controller, setController,
    grounding, setGrounding,
    waiting,
    answer: (text: string) => command(() => window.desktop.answer(text)),
    refreshHealth,
    stop: () => command(() => window.desktop.cancel()),
    openPermissions: () => command(() => window.desktop.openAccessibilitySettings()),
  };
}
