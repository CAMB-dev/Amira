import { array, bool, constrain, id, object, text, enumeration as values } from "./base.ts"
import { acknowledgement } from "./frontend.ts"
import { modelInfo } from "./messages.ts"

export const bindingMetadata = object({
  model: modelInfo,
  revision: id,
  available: bool,
  replay: object({ dialect: text, provider: text, host: text, model: text, webSearch: bool }),
  "native?": object({
    dialect: text,
    methods: array(text),
    layouts: array(values("tail", "recent-user")),
    midTurn: bool,
  }),
})

export const bindingSchemas = {
  "proxy.describe": {
    params: object({}),
    result: object({
      enabled: bool,
      models: constrain(array(modelInfo), { maxItems: 4096 }),
      origins: array(object({ provider: text, origin: text })),
    }),
  },
  "proxy.bind": {
    params: object({ metadata: constrain(array(bindingMetadata), { maxItems: 4096 }) }),
    result: acknowledgement,
  },
}
