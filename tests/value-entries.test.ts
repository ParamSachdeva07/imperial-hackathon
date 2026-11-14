import { describe, expect, it } from 'vitest';
import { ValueEntries } from '../apps/desktop/electron/controller/value-entries';
import type { DesktopObservation, DesktopCandidate } from '../packages/contracts/src/index';

const field = { ref: '@s1:e1', role: 'combobox', name: 'Setting', nativeId: 'setting',
  value: '24', states: [] as string[], actions: ['SetValue', 'SetFocus'] };
const observation: DesktopObservation = { id: 'o1', capturedAt: 1, applications: [], windows: [], notices: [],
  context: { app: 'Example', windowId: 'w1' }, snapshots: [{ id: 's1', app: 'Example', windowId: 'w1',
    windowTitle: 'Example', complete: true, capturedAt: 1, elements: [field] }] };
const write: DesktopCandidate = { id: 'set', operation: 'SET_VALUE', app: 'Example', windowId: 'w1',
  name: 'Setting', description: '', snapshotId: 's1', targetRef: field.ref, inputId: 'setting' };
const report = { operation: 'SET_VALUE', target: 'Setting', delivery: 'delivered_verified' as const,
  verification: 'verified' as const, observedValue: '24' };

describe('Value entry evidence', () => {
  it('records verified entry without requiring an acceptance action', () => {
    const tracker = new ValueEntries();
    tracker.record({ ...write, operation: 'FOCUS_AND_PASTE' }, observation, { ...report, operation: 'FOCUS_AND_PASTE' });
    tracker.observe(observation);
    expect(tracker.notices()[0]).toContain('"enteredValue":"24"');
    expect(tracker.notices()[0]).toContain('"visibility":"observed"');
    expect(tracker.notices()[0]).toContain('controls may apply immediately or require a commit');
    expect(tracker.notices()[0]).not.toContain('acceptanceAttempted');
  });
  it.each(['return', 'tab'])('records %s as an interaction, not proof of application', key => {
    const tracker = new ValueEntries(); tracker.record(write, observation, report);
    tracker.record({ ...write, operation: 'PRESS', key, targetRef: undefined }, observation);
    expect(tracker.notices()[0]).toContain('"key":"' + key + '"');
    expect(tracker.notices()[0]).toContain('Entry and later interactions do not prove the requested effect');
  });
  it('records clicks by observed identity without recognizing an English Apply label', () => {
    const tracker = new ValueEntries(); tracker.record(write, observation, report);
    tracker.record({ ...write, operation: 'CLICK', name: 'Appliquer' }, observation);
    expect(tracker.notices()[0]).toContain('"target":"Appliquer"');
    tracker.observe({ ...observation, snapshots: [] });
    expect(tracker.notices()[0]).toContain('"visibility":"not_in_scope"');
    expect(tracker.notices()[0]).toContain('Missing here means unknown');
  });
  it('tracks fresh values and focus across label and window-title changes using IDs', () => {
    const tracker = new ValueEntries(); tracker.record(write, observation, report);
    tracker.observe({ ...observation, snapshots: [{ ...observation.snapshots[0], windowTitle: 'Renamed',
      elements: [{ ...field, name: 'Renamed setting', value: '32', states: ['focused'] }] }] });
    expect(tracker.notices()[0]).toContain('"current":{"value":"32","focused":true}');
  });
  it('does not infer a result from ambiguous identity, reads or another window', () => {
    const tracker = new ValueEntries(); tracker.record(write, observation, report);
    tracker.record({ ...write, operation: 'INSPECT_REGION' }, observation);
    tracker.record({ ...write, operation: 'PRESS', key: 'return', windowId: 'other' }, observation);
    tracker.observe({ ...observation, snapshots: [{ ...observation.snapshots[0],
      elements: [field, { ...field, ref: '@s1:e2' }] }] });
    expect(tracker.notices()[0]).toContain('"interactions":[]');
    expect(tracker.notices()[0]).toContain('"visibility":"ambiguous"');
    expect(tracker.notices()[0]).toContain('Do not submit a prefill-only request');
  });
  it('retains follow-up evidence when the same value is already satisfied', () => {
    const tracker = new ValueEntries(); tracker.record(write, observation, report);
    tracker.record({ ...write, operation: 'PRESS', key: 'tab' }, observation);
    tracker.record(write, observation, { ...report, verification: 'already_satisfied', delivery: 'not_delivered' });
    expect(tracker.notices()).toHaveLength(1);
    expect(tracker.notices()[0]).toContain('"key":"tab"');
  });
  it('keeps identically named fields distinct and bounds context', () => {
    const tracker = new ValueEntries();
    const second = { ...field, ref: '@s1:e2', nativeId: 'other' };
    const two = { ...observation, snapshots: [{ ...observation.snapshots[0], elements: [field, second] }] };
    tracker.record(write, two, { ...report, observedValue: 'x'.repeat(5000) });
    tracker.record({ ...write, targetRef: second.ref }, two, report);
    tracker.observe(two);
    expect(tracker.notices()).toHaveLength(2);
    expect(tracker.notices().every(n => n.length <= 1000)).toBe(true);
  });
  it('does not call an uncertain or unreadable write verified entry, and clears between tasks', () => {
    const tracker = new ValueEntries();
    tracker.record(write, observation, { ...report, verification: 'unverified', delivery: 'uncertain' });
    tracker.record(write, observation, { ...report, observedValue: undefined });
    expect(tracker.notices()).toEqual([]);
    tracker.record(write, observation, report);
    tracker.clear();
    expect(tracker.notices()).toEqual([]);
  });
});
