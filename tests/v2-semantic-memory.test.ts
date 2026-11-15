import { describe, expect, it } from 'vitest';
import { SemanticMemory } from '../apps/desktop/electron/controller/v2/semantic-memory';
import type { SemanticRecord } from '../packages/contracts/src/index';

const record = (i: number): SemanticRecord => ({ taskId: 'task', kind: 'assignment', summary: 'Assignment ' + i,
  inputs: [{ name: 'selected input', value: 'value ' + i }], facts: ['Observed result ' + i] });

describe('semantic orchestration memory', () => {
  it('appends a stable prefix within one orchestration and isolates new instances', () => {
    const memory = new SemanticMemory();
    memory.append(record(1));
    const before = memory.context();
    memory.append(record(2));
    expect(memory.context().slice(0, 1)).toEqual(before);
    expect(new SemanticMemory().context()).toEqual([]);
    before[0].inputs[0].value = 'modified outside store';
    expect(memory.context()[0].inputs[0].value).toBe('value 1');
  });

  it('checkpoints older semantic records within the context budget while retaining current inputs', () => {
    const memory = new SemanticMemory(1600);
    for (let i = 0; i < 20; i++) memory.append(record(i));
    const context = memory.context();
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(1600);
    expect(context.at(-1)?.inputs[0].value).toBe('value 19');
    expect(context[0].kind).toBe('checkpoint');
    memory.append(record(20));
    expect(memory.context().slice(0, -1)).toEqual(context);
  });
});
