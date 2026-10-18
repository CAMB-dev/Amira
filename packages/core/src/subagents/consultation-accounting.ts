import type { Usage } from "@amira/ai"
import { type AccountingTarget, requestAccountingTarget } from "../accounting-requests.ts"
import type { Agent } from "../agent.ts"
import { type ConsultationUsageRecorder, consultationUsageRecorder } from "./consultation-usage.ts"

interface ConsultationAccounting {
  agent: Agent
  target: AccountingTarget
}

const contexts = new WeakMap<ConsultationUsageRecorder, ConsultationAccounting>()

/** Capture the booking destination before admission or late cleanup can outlive its requester. */
export function accountedConsultation(owner: Agent, book: (usage: Usage) => void): ConsultationUsageRecorder {
  const recorder = consultationUsageRecorder(book)
  const target = requestAccountingTarget(owner)
  contexts.set(recorder, {
    agent: owner,
    target: {
      store: target.store ?? owner.session,
      ...(target.attribution ? { attribution: { ...target.attribution } } : {}),
    },
  })
  return recorder
}

/** The commander's model may answer, but the captured booking owner supplies accounting identity. */
export function consultationAccounting(
  recorder: ConsultationUsageRecorder,
): ConsultationAccounting | undefined {
  return contexts.get(recorder)
}
