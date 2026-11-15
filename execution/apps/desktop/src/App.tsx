import { useState } from 'react';
import { LiveLog } from './LiveLog';
import { useDesktopSession } from './useDesktopSession';

const statusLabels: Record<string, string> = {
  idle: 'Ready',
  preparing: 'Preparing',
  observing: 'Reading the screen',
  deciding: 'Choosing the next step',
  executing: 'Acting',
  verifying: 'Checking the result',
  stopping: 'Stopping',
  cancelled: 'Stopped',
  blocked: 'Needs attention',
  completed: 'Complete',
  completed_unverified: 'Done, not fully verified',
  failed: 'Needs attention',
};
export default function App() {
  const session = useDesktopSession();
  const [goal, setGoal] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [overlayError, setOverlayError] = useState('');
  const status = session.state?.status || 'idle';
  const canRun = session.ready && session.connected && !session.pending && !!goal.trim();
  const events = session.state?.events || [];
  async function submit() {
    const submitted = goal;
    if (canRun && await session.run(submitted))
      setGoal(current => current === submitted ? '' : current);
  }
  async function toggleLog() {
    const result = await window.desktop.setOverlayExpanded(!expanded);
    if (result.ok) { setExpanded(!expanded); setOverlayError(''); }
    else setOverlayError(result.error);
  }
  return (
    <main className={'assistant' + (expanded ? '' : ' compact')}>
      <header className="app-header">
        <h1>Desktop Assistant</h1>
        <span className={'connection ' + (session.connected ? 'connected' : '')}>
          {session.connected ? 'Connected' : session.health?.backend.available && !session.modelsConfigured ? 'Setup needed' : 'Not connected'}
        </span>
      </header>
      <section className="instruction-panel" aria-label="Task instruction">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canRun) void submit();
          }}
        >
          <label className="visually-hidden" htmlFor="goal">What would you like to do?</label>
          <textarea
            id="goal"
            rows={2}
            maxLength={1000}
            value={goal}
            placeholder={session.busy ? 'New instruction replaces the current task…' : 'What would you like to do?'}
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canRun) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="task-controls">
            <button type="submit" className="primary" aria-label="Send instruction" disabled={!canRun}>
              {session.pending ? 'Starting…' : 'Send'}
            </button>
            {session.busy && <button
              type="button"
              className="stop"
              onClick={session.stop}
            >
              Stop
            </button>}
            <button type="button" className="log-toggle" aria-expanded={expanded} aria-controls="activity" onClick={() => void toggleLog()}>
              {expanded ? 'Hide log' : 'Show log'}
            </button>
          </div>
        </form>
        {(session.error || overlayError) && (
          <p className="error-message" role="alert">
            {session.error || overlayError}
          </p>
        )}
        {session.health?.backend.available && !session.modelsConfigured &&
          <p className="error-message" role="status">Setup: add the navigator and orchestrator API keys to services/decision-api/.env and restart the app.</p>}
        {session.health?.native.available && session.health.native.accessibility !== 'granted' && (
          <p className="error-message">
            Accessibility permission is needed.{' '}
            <button className="text-button" onClick={session.openPermissions}>
              Open System Settings
            </button>
          </p>
        )}
        {expanded && <details className="connection-details">
          <summary>Settings and connection</summary>
          <p>Luna plans the task and the navigator carries it out, one session after another, until Luna finishes it. Stop or send a new instruction at any time.</p>
          <p>Chrome page bridge: {session.health?.pageBridge?.connected ? 'connected'
            : session.health?.pageBridge?.needsReload ? 'an older copy is loaded: press reload on it in chrome://extensions'
            : 'not connected (pages are read through accessibility)'}</p>
          <p>Luna: {session.health?.backend.orchestratorModel || 'unavailable'} · Navigator: {session.health?.backend.navigatorModel || 'unavailable'}</p>
          <p>Drag the title to move this overlay. ⌘ Enter to run · ⌘ ⇧ . to stop · ⌘ ⇧ Space to show it.</p>
          <button className="text-button" onClick={session.refreshHealth}>
            Check connection
          </button>
          {!session.connected && (
            <p role="status">
              {session.health?.native.message ||
                session.health?.backend.message ||
                'Check Accessibility permission and the decision service configuration.'}
            </p>
          )}
        </details>}
      </section>
      <section id="activity" className="log-panel" aria-labelledby="log-title">
        <div className="log-heading">
          <h2 id="log-title">Live log</h2>
          <span className={'status ' + status}>{statusLabels[status]}</span>
          <span className="step-count">Steps {session.state?.step || 0}</span>
        </div>
        <p className="current-message" title={events.at(-1)?.message} aria-live="polite" aria-atomic="true">
          {events.at(-1)?.message || 'Ready for your instruction.'}
        </p>
        {expanded && <LiveLog events={events} />}
      </section>
    </main>
  );
}
