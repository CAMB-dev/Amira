import { agentPresenter } from "../../../../extensions/agent/src/index.ts"
import { builtinPresenters } from "../../../../extensions/builtin-tools/src/index.ts"

/** Pure presentation only: never invoke executable builtin extension registration locally. */
export const remoteBuiltinPresenters = {
  get(name: string) {
    return name === "agent" ? agentPresenter : builtinPresenters[name as keyof typeof builtinPresenters]
  },
}
