import type { ActStarted, Event, JournalRecord } from '@nox/protocol'

export interface RunningActRecovery {
  act: ActStarted
  eventId: string
}

export interface RecoveryAnalysis {
  admittedEventsWithoutAct: Event[]
  runningActs: RunningActRecovery[]
}

export function analyzeRecovery(records: JournalRecord[]): RecoveryAnalysis {
  const events = new Map<string, Event>()
  const admittedEventIds = new Set<string>()
  const startedByEvent = new Set<string>()
  const startedActs = new Map<string, RunningActRecovery>()
  const terminalActs = new Set<string>()

  for (const record of [...records].sort((left, right) => left.sequence - right.sequence)) {
    if (record.entry.kind === 'event.recorded') {
      const event = record.entry.event
      events.set(event.eventId, event)
      if (event.admission === 'admitted') {
        admittedEventIds.add(event.eventId)
      }
    } else if (record.entry.kind === 'event.admitted') {
      admittedEventIds.add(record.entry.eventId)
    } else if (record.entry.kind === 'act.started') {
      const eventId = record.entry.act.input.triggerEventId
      startedByEvent.add(eventId)
      startedActs.set(record.entry.act.actId, { act: record.entry.act, eventId })
    } else if (record.entry.kind === 'act.terminal') {
      terminalActs.add(record.entry.terminal.actId)
    }
  }

  const admittedEventsWithoutAct = [...admittedEventIds]
    .filter(eventId => !startedByEvent.has(eventId))
    .map(eventId => {
      const event = events.get(eventId)
      if (event === undefined) {
        throw new Error(`Admitted Event has no recorded payload: ${eventId}`)
      }
      return event.kind === 'external' ? { ...event, admission: 'admitted' as const } : event
    })
    .sort((left, right) =>
      left.occurredAt < right.occurredAt
        ? -1
        : left.occurredAt > right.occurredAt
          ? 1
          : left.eventId < right.eventId
            ? -1
            : 1
    )

  return {
    admittedEventsWithoutAct,
    runningActs: [...startedActs.values()].filter(({ act }) => !terminalActs.has(act.actId))
  }
}
