import { describe, expect, it } from 'vitest';
import { CompletionVerifier } from '../apps/desktop/electron/controller/completion-verifier';
import type { Decision, DesktopDecisionRequest, DesktopObservation, Element, OutcomeCheck } from '../packages/contracts/src/index';
const target = (name: string, role = '') => ({ app: 'Media fixture', windowTitle: 'Retrieval introduction', role, name });
const checks: OutcomeCheck[] = [
  { kind: 'target_present', target: target('Pausar', 'button'), value: '' },
  { kind: 'state_absent', target: target('Pausar', 'button'), value: 'disabled' },
  { kind: 'value_advances', target: target('Progreso', 'slider'), value: '' },
];
const request = {
  supervisor: { status: 'completed', expectedOutcome: { kind: 'media_playing', target: target(''), value: '', checks } },
  goal: 'Reproduce el primer vídeo.', phase: { index: 0, count: 1 }, tree: { view: 'tree' },
} as DesktopDecisionRequest;
const decision = { candidateId: 'DONE', goalStatus: 'completed', confidence: 0.001, goalConfidence: 0.001 } as Decision;
const control = (role: string, name: string, value = '', states: string[] = []): Element => ({
  ref: '@s1:e1', role, name, value, states, actions: role === 'button' ? ['Click'] : [],
});
const pause = () => control('button', 'Pausar');
const seek = (value: string) => control('slider', 'Progreso', value);
function observed(n: number, elements: Element[], title = 'Retrieval introduction'): DesktopObservation {
  return { id: 'o' + n, capturedAt: n * 1000, context: { driver: 'native', app: 'Media fixture', windowId: 'w1', surface: 'window' },
    applications: [], windows: [], notices: [], snapshots: [{ id: 's' + n, app: 'Media fixture', windowId: 'w1',
      windowTitle: title, capturedAt: n * 1000, complete: true, elements, text: ['Title: ' + title] }] };
}
const assess = (v: CompletionVerifier, o: DesktopObservation, r = request) => v.assess(r, decision, o);

describe('Explicit native outcome contracts', () => {
  it.each([['10', '11'], ['01:09', '01:10'], ['1:02:03', '1:02:04'], ['10%', '11%'], ['10 segundos', '11 segundos']])(
    'verifies localized playback controls and advancing measurements %s -> %s', (before, after) => {
      const v = new CompletionVerifier();
      expect(assess(v, observed(1, [pause(), seek(before)])).kind).toBe('refresh');
      expect(assess(v, observed(2, [pause(), seek(after)])).kind).toBe('confirmed');
    });
  it('does not complete a different playing video', () => {
    const v = new CompletionVerifier();
    assess(v, observed(1, [pause(), seek('10')]));
    expect(assess(v, observed(2, [pause(), seek('11')], 'Different video')).kind).toBe('refresh');
  });
  it('does not use metadata, Play availability or volume changes as playback proof', () => {
    for (const elements of [[control('heading', 'Retrieval introduction')],
      [control('button', 'Reproducir'), seek('10')], [pause(), control('slider', 'Volumen', '90')]]) {
      const v = new CompletionVerifier();
      expect(assess(v, observed(1, elements)).kind).toBe('refresh');
      expect(v.needsEvidence()).toBe(true);
      assess(v, observed(2, elements));
      expect(assess(v, observed(3, elements)).kind).toBe('blocked');
    }
  });
  it('requires an intended identity and bound active and position controls', () => {
    const v = new CompletionVerifier();
    const r = structuredClone(request);
    r.supervisor!.expectedOutcome.checks = [];
    expect(assess(v, observed(1, [pause(), seek('10')]), r)).toMatchObject({ kind: 'refresh', message: expect.stringContaining('bound active-state') });
  });
  it('never accepts stationary, stale, reset or ambiguous measurements', () => {
    for (const after of [observed(2, [pause(), seek('10')]), observed(1, [pause(), seek('11')]),
      observed(2, [pause(), seek('1')]), observed(2, [pause(), seek('11'), seek('12')])]) {
      const v = new CompletionVerifier();
      assess(v, observed(1, [pause(), seek('10')]));
      expect(assess(v, after).kind).toBe('refresh');
    }
  });
  it.each(['hidden', 'offscreen', 'disabled'])('rejects an unavailable active control: %s', state => {
    const v = new CompletionVerifier();
    assess(v, observed(1, [pause(), seek('10')]));
    expect(assess(v, observed(2, [control('button', 'Pausar', '', [state]), seek('11')])).kind).toBe('refresh');
  });
  it('checks exact text on the current observation without a redundant supervised model roundtrip', () => {
    const r = structuredClone(request);
    r.supervisor!.expectedOutcome = { kind: 'text_equals', description: 'Requested document body', target: target('Body', 'textfield'), value: 'hello', checks: [] };
    const v = new CompletionVerifier();
    const body = control('textfield', 'Body', 'hello');
    expect(assess(v, observed(1, [body]), r).kind).toBe('confirmed');
    expect(assess(v, observed(2, [body]), r).kind).toBe('confirmed');
    v.clear();
    assess(v, observed(3, [body]), r);
    expect(assess(v, observed(4, [{ ...body, value: 'hellohello' }]), r).kind).toBe('refresh');
  });
  it('does not infer goal type by English keywords', () => {
    const v = new CompletionVerifier();
    const r = structuredClone(request);
    r.goal = 'Do the requested action';
    assess(v, observed(1, [pause(), seek('10')]), r);
    expect(assess(v, observed(2, [pause(), seek('11')]), r).kind).toBe('confirmed');
  });
});
