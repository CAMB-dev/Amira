import type { Usage } from "@amira/ai"

/** One attempt is observed eagerly and settled once with its latest terminal usage. */
export type ConsultationUsageRecorder = ((usage: Usage) => void) & {
  observe?: (usage: Usage) => void
}

/** Captured for a consultation; its receipt resets whenever an attempt is settled. */
export function consultationUsageRecorder(book: (usage: Usage) => void): ConsultationUsageRecorder {
  let charged: Usage | undefined
  const observe = (usage: Usage) => {
    // Provider messages and their usage objects can be reused or changed after an event.
    const snapshot = { ...usage }
    const previous = charged
    for (const key of ["reasoning", "webSearchRequests", "webSearchCost", "cost"] as const) {
      const known = previous?.[key]
      if (snapshot[key] === undefined && known !== undefined) snapshot[key] = known
    }
    charged = snapshot
    if (
      previous &&
      (previous.webSearchRequests ?? 0) > 0 &&
      previous.webSearchCost === undefined &&
      snapshot.webSearchCost !== undefined
    ) {
      // Pricing an earlier unknown search replaces that contribution, not another search.
      // Signed journal rows also let freshly reopened sessions reconstruct the correction.
      book(inverse(previous))
      book(snapshot)
    } else {
      const delta = previous ? difference(snapshot, previous) : snapshot
      if (!previous || hasAmounts(delta)) book(delta)
    }
  }
  return Object.assign(
    (usage: Usage) => {
      try {
        observe(usage)
      } finally {
        charged = undefined
      }
    },
    { observe },
  )
}

function difference(usage: Usage, charged: Usage): Usage {
  const delta: Usage = {
    input: usage.input - charged.input,
    output: usage.output - charged.output,
    cacheRead: usage.cacheRead - charged.cacheRead,
    cacheWrite: usage.cacheWrite - charged.cacheWrite,
  }
  // Missing metadata is unknown, not a negative charge or a reported zero.
  for (const key of ["reasoning", "webSearchRequests", "webSearchCost", "cost"] as const) {
    if (usage[key] !== undefined) delta[key] = usage[key] - (charged[key] ?? 0)
  }
  if (usage.outputReported !== undefined) delta.outputReported = usage.outputReported
  return delta
}

function inverse(usage: Usage): Usage {
  const credit: Usage = {
    input: -usage.input,
    output: -usage.output,
    cacheRead: -usage.cacheRead,
    cacheWrite: -usage.cacheWrite,
  }
  for (const key of ["reasoning", "webSearchRequests", "webSearchCost", "cost"] as const) {
    if (usage[key] !== undefined) credit[key] = -usage[key]
  }
  if (usage.outputReported !== undefined) credit.outputReported = usage.outputReported
  return credit
}

function hasAmounts(usage: Usage): boolean {
  return [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.reasoning,
    usage.webSearchRequests,
    usage.webSearchCost,
    usage.cost,
  ].some((value) => value !== undefined && value !== 0)
}
