import type { TaskInput } from '../../../../packages/contracts/src/index';
export function exactInputs(input: TaskInput): { id: string; text: string }[] {
  if (input.inputs?.length) return input.inputs;
  const values = input.text ? [input.text] : [];
  // Preserve exact user-provided spans. Jev chooses a named input; it cannot invent text.
  for (const match of input.goal.matchAll(/"([^"\n]+)"|“([^”\n]+)”|'([^'\n]+)'/g)) {
    const value = match[1] || match[2] || match[3];
    if (!values.includes(value)) values.push(value);
  }
  return values.slice(0, 8).map((text, i) => ({ id: 'text_' + (i + 1), text }));
}

/** Planning may add arguments, but cannot replace user-supplied literal values. */
export function executionInputs(input: TaskInput, planned: { id: string; text: string }[] = []) {
  const original = exactInputs(input);
  return [...original, ...planned.filter(item =>
    !original.some(value => value.id === item.id || value.text === item.text))].slice(0, 8);
}
