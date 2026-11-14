import { useEffect, useRef } from 'react';
import type { TaskEvent } from '../../../packages/contracts/src/index';

export function LiveLog({ events }: { events: TaskEvent[] }) {
  const container = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    const log = container.current;
    if (log && following.current) log.scrollTop = log.scrollHeight;
  }, [events.at(-1)?.id]);
  return (
    <div
      className="live-log"
      ref={container}
      role="region"
      aria-label="Live task log"
      tabIndex={0}
      onScroll={(event) => {
        const node = event.currentTarget;
        following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60;
      }}
    >
      {!events.length && (
        <p className="empty-log">Actions and results will appear here when you run a task.</p>
      )}
      <ol>
        {events.map((event) => (
          <li className={'log-entry ' + event.type} key={event.id}>
            <time dateTime={new Date(event.at).toISOString()}>
              {new Date(event.at).toLocaleTimeString([], { hour12: false })}
            </time>
            <div>
              <span className="event-type">{event.type}</span>
              <p>{event.message}</p>
              {event.details && (
                <details>
                  <summary>Details</summary>
                  <pre>{JSON.stringify(event.details, null, 2)}</pre>
                </details>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
