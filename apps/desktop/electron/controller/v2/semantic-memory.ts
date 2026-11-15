import { SemanticRecordSchema, type SemanticRecord } from '../../../../../packages/contracts/src/index';

/** Working memory for ONE orchestration. Append semantic results, not every click/tree. */
export class SemanticMemory {
  private records: SemanticRecord[] = [];
  private prefix: SemanticRecord[] = [];
  private prefixEnd = 0;
  constructor(private contextChars = 48_000) {}

  append(record: SemanticRecord) {
    const clean = SemanticRecordSchema.parse(record);
    if (JSON.stringify(this.records.at(-1)) === JSON.stringify(clean)) return;
    this.records.push(structuredClone(clean));
  }

  context(): SemanticRecord[] {
    let selected = [...this.prefix, ...this.records.slice(this.prefixEnd)];
    // Rebuild a checkpoint only at a context boundary. Until then the entire semantic prefix
    // stays byte-for-byte identical, so model requests can reuse their cached prefix.
    if (JSON.stringify(selected).length > this.contextChars) {
      let tailStart = this.records.length;
      let used = 0;
      while (tailStart > 0 && (tailStart === this.records.length ||
        used + JSON.stringify(this.records[tailStart - 1]).length < this.contextChars / 2))
        used += JSON.stringify(this.records[--tailStart]).length;
      const old = this.records.slice(0, tailStart);
      const facts = [...new Set(old.flatMap(r => r.facts))].slice(-80);
      const inputs = [...new Map(old.flatMap(r => r.inputs).map(i => [i.name + '\0' + i.value, i])).values()].slice(-32);
      const checkpoint: SemanticRecord = { taskId: old.at(-1)?.taskId || '', kind: 'checkpoint', inputs: [], facts: [],
        summary: 'Earlier inputs and observed results from this orchestration. Current observations supersede old state.' };
      const budget = Math.max(0, Math.min(this.contextChars / 4, this.contextChars - used - 32));
      for (const input of [...inputs].reverse()) {
        checkpoint.inputs.unshift(input);
        if (JSON.stringify(checkpoint).length > budget) checkpoint.inputs.shift();
      }
      for (const fact of [...facts].reverse()) {
        checkpoint.facts.unshift(fact);
        if (JSON.stringify(checkpoint).length > budget) checkpoint.facts.shift();
      }
      this.prefix = JSON.stringify(checkpoint).length <= budget ? [checkpoint] : [];
      this.prefixEnd = tailStart;
      selected = [...this.prefix, ...this.records.slice(tailStart)];
    }
    return structuredClone(selected);
  }
}
