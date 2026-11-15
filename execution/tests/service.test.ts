import { afterEach, describe, expect, it } from 'vitest';
import type { ControllerState, TaskStatus } from '../packages/contracts/src/index';
import type { NavigationController } from '../apps/desktop/electron/controller/navigation';
import { ExecutionService } from '../apps/desktop/electron/service';

/** A controller that finishes a task when told to, so the service can be tested without a desktop. */
function fakeController() {
  let state: ControllerState = { taskId: null, status: 'idle', busy: false, input: null, step: 0, events: [], plan: [], completion: null };
  const listeners = new Set<(s: ControllerState) => void>();
  const set = (patch: Partial<ControllerState>) => { state = { ...state, ...patch }; for (const l of listeners) l(state); return state; };
  const started: string[] = [];
  const begin = (input: any) => { if (!input.goal) throw new Error('goal is required'); started.push(input.goal + '|' + (input.context ?? ''));
    return set({ taskId: 't' + started.length, status: 'preparing', busy: true, completion: null, input: { goal: input.goal, context: input.context ?? '', app: '', allowPhysical: false } }); };
  const controller = { state: () => state, subscribe: (l: (s: ControllerState) => void) => { listeners.add(l); return () => listeners.delete(l); },
    start: begin, replace: async (input: unknown) => begin(input), cancel: () => set({ status: 'cancelled', busy: false }) };
  return { controller: controller as unknown as NavigationController, started,
    finish: (status: TaskStatus, summary: string) => set({ status, busy: false, completion: { summary, facts: ['heading "Twitch"'], location: { app: 'Google Chrome', window: 'Twitch', address: 'https://www.twitch.tv/' } } }) };
}
const services: ExecutionService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.stop(); });
async function setup() {
  const fake = fakeController();
  const service = new ExecutionService(fake.controller, null);
  services.push(service);
  const { port, token } = await service.start();
  const call = (method: string, route: string, body?: unknown, auth = token) => fetch('http://127.0.0.1:' + port + route,
    { method, headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { ...fake, call, port, token };
}

describe('the execution service', () => {
  it('answers only a caller that holds the token', async () => {
    const { call } = await setup();
    expect((await call('GET', '/state', undefined, 'wrong')).status).toBe(401);
    expect((await call('POST', '/task', { goal: 'x' }, '')).status).toBe(401);
    expect((await call('GET', '/state')).status).toBe(200);
  });

  it('starts a task at once, replaces a running one, and reports how it ended and where it left the desktop', async () => {
    const { call, started, finish } = await setup();
    expect(await (await call('POST', '/task', { goal: 'open twitch', context: 'Chrome is open' })).json()).toEqual({ taskId: 't1' });
    expect(await (await call('POST', '/task', { goal: 'open youtube' })).json()).toEqual({ taskId: 't2' });
    expect(started).toEqual(['open twitch|Chrome is open', 'open youtube|']);
    finish('completed', 'YouTube is open.');
    expect(await (await call('GET', '/state')).json()).toMatchObject({ taskId: 't2', status: 'completed', busy: false, goal: 'open youtube',
      completion: { summary: 'YouTube is open.', location: { app: 'Google Chrome' } } });
    expect((await call('POST', '/task', {})).status).toBe(400);
  });

  it('streams each change, and stops the task on request', async () => {
    const { call, finish } = await setup();
    const stream = await call('GET', '/events');
    const reader = stream.body!.getReader();
    const next = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).replace(/^data: /, ''));
    expect((await next()).status).toBe('idle');
    await call('POST', '/task', { goal: 'open twitch' });
    expect((await next()).status).toBe('preparing');
    finish('blocked', 'The site needs a sign-in.');
    expect(await next()).toMatchObject({ status: 'blocked', completion: { summary: 'The site needs a sign-in.' } });
    expect(await (await call('POST', '/stop')).json()).toMatchObject({ status: 'cancelled' });
    await reader.cancel();
  });
});
