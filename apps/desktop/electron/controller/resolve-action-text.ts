import {
  TextResolutionSchema,
  type DesktopCandidate,
  type DesktopDecisionRequest,
  type DesktopObservation,
} from '../../../../packages/contracts/src/index';
import type { DecisionProvider } from '../services/decision-client';
import type { LoopHost } from './desktop-loop';

export async function resolveActionText(
  provider: DecisionProvider,
  host: LoopHost,
  candidate: DesktopCandidate,
  request: DesktopDecisionRequest,
  observation: DesktopObservation,
  history: string[],
  signal: AbortSignal,
) {
  const taskId = request.taskId;
  let text = candidate.inputId
    ? request.inputs.find((item) => item.id === candidate.inputId)?.text
    : undefined;
  if (candidate.inputFromGoal) {
    if (!provider.resolveText) throw new Error('This decision provider cannot interpret instruction text.');
    host.status(
      'deciding',
      'Understanding what to ' +
        (candidate.operation === 'SEARCH_APPS'
          ? 'search for in Spotlight.'
          : 'type into ' + candidate.name + '.'),
    );
    const target = observation.snapshots
      .flatMap((s) => s.elements)
      .find((e) => e.ref === candidate.targetRef);
    const resolved = TextResolutionSchema.parse(
      await provider.resolveText(
        {
          taskId,
          snapshotId: observation.id,
          candidateId: candidate.id,
          goal: request.overallGoal,
          purpose: candidate.operation === 'SEARCH_APPS' ? 'app_name' : 'field_text',
          target: {
            app: candidate.app,
            role: candidate.role || 'application-search',
            name: candidate.name,
            description: candidate.description,
            value: (target?.value || '').slice(0, 2000),
          },
          history: history.slice(-10),
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    if (
      resolved.taskId !== taskId ||
      resolved.snapshotId !== observation.id ||
      resolved.candidateId !== candidate.id
    )
      throw new Error('Rejected stale text interpretation.');
    if (resolved.status !== 'resolved') {
      const reason =
        resolved.reason === 'no_span'
          ? 'no suitable text was found in the instruction'
          : resolved.reason === 'invalid_boundaries'
            ? 'the selected text boundaries were inconsistent'
            : resolved.reason === 'unsupported'
              ? 'the separate check rejected the proposed text'
              : 'the intended text was not resolved';
      const message = `Skipped typing into ${candidate.name}: ${reason}. No input was sent. Jev can choose another action.`;
      host.event('decision', message, {
        reason: resolved.reason,
        proposedText: resolved.proposedText,
        supportConfidence: resolved.supportConfidence,
      });
      history.push(message);
      return { resolved: false } as const;
    }
    // Python offsets count Unicode code points, not UTF-16 string units.
    const source = Array.from(request.overallGoal);
    if (
      !resolved.text ||
      resolved.end <= resolved.start ||
      resolved.end > source.length ||
      source.slice(resolved.start, resolved.end).join('') !== resolved.text
    )
      throw new Error('Interpreted text is not an exact span of the user instruction.');
    text = resolved.text;
    host.event('decision', 'Understood ' + JSON.stringify(text) + ' for ' + candidate.name + '.', {
      confidence: resolved.confidence,
      supportConfidence: resolved.supportConfidence,
    });
  }
  return { resolved: true, text } as const;
}
