import { expect, it } from 'vitest';
import { TaskInputSchema } from '../packages/contracts/src/index';
import { executionInputs } from '../apps/desktop/electron/controller/task-instructions';

it('keeps literal arguments when a planning summary omits or changes them', () => {
  const task = TaskInputSchema.parse({ provider: 'jev', goal: 'Write "hello how are you in it" and use 24 pt.' });
  expect(executionInputs(task, [{ id: 'text_1', text: 'hello how are you' }, { id: 'size', text: '24' }]))
    .toEqual([{ id: 'text_1', text: 'hello how are you in it' }, { id: 'size', text: '24' }]);
});
