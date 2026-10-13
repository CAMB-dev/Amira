import { isolateTestHome } from "../../../scripts/test-home.ts"

process.on("exit", isolateTestHome())
