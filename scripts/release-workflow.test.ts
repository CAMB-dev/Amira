import { expect, test } from "bun:test"

interface Step {
  id?: string
  name?: string
  uses?: string
  run?: string
  if?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}
interface Job {
  needs?: string | string[]
  if?: string
  permissions?: Record<string, string>
  outputs?: Record<string, string>
  strategy?: { matrix: Record<string, unknown> }
  steps: Step[]
}
interface Workflow {
  on: { push: { tags: string[] }; workflow_dispatch: { inputs: Record<string, { default: unknown }> } }
  permissions: Record<string, string>
  concurrency: Record<string, unknown>
  jobs: Record<string, Job>
}

const source = await Bun.file(new URL("../.github/workflows/release.yml", import.meta.url)).text()
const workflow = Bun.YAML.parse(source) as Workflow
const nightly = Bun.YAML.parse(
  await Bun.file(new URL("../.github/workflows/nightly.yml", import.meta.url)).text(),
) as Workflow
function script(job: string) {
  return workflow.jobs[job]!.steps.map((step) => step.run ?? "").join("\n")
}

test("release workflow parses as YAML and every action uses an immutable SHA", () => {
  expect(workflow.on.push.tags).toEqual(["v*"])
  expect(workflow.on.workflow_dispatch.inputs["dry-run"]!.default).toBe(true)
  expect(workflow.permissions).toEqual({ contents: "read" })
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false)
  const uses = Object.values(workflow.jobs).flatMap((job) =>
    job.steps.flatMap((step) => (step.uses ? [step.uses] : [])),
  )
  expect(uses.length).toBeGreaterThan(10)
  for (const action of uses) expect(action).toMatch(/^[\w/-]+@[a-f0-9]{40}$/)
})

test("canonical tag and matching source version are prerequisites for every release", () => {
  expect(script("plan")).toContain('if [[ "$GITHUB_REF_TYPE" == tag ]]; then')
  // Branches are only accepted for a dry run of main, which never publishes.
  expect(script("plan")).toContain('elif [[ "$DRY_RUN" == true && "$GITHUB_REF_NAME" == main ]]; then')
  expect(script("plan")).toContain("only a dry run may use the main branch")
  expect(script("plan")).toContain('bun scripts/version-sync.ts check "$TAG"')
  expect(script("plan")).toContain("CHANNEL=next")
  expect(workflow.jobs.check!.needs).toBe("plan")
  expect(workflow.jobs.check!.strategy!.matrix.os).toEqual([
    "ubuntu-latest",
    "windows-latest",
    "macos-latest",
  ])
  // Release checks use CI's runner, which retries a failed test file once.
  expect(script("check")).toContain(
    "bun run architecture:check && bun run typecheck && bun run lint && bun scripts/ci-test.ts",
  )
  expect(workflow.jobs.check!.steps[0]!.with!["fetch-depth"]).toBe(0)
  expect(workflow.jobs.build!.needs).toEqual(["plan", "check"])
  expect(script("build")).toContain('bun run build:all --version "$VERSION" --channel "$CHANNEL"')
  expect(workflow.jobs.smoke!.needs).toBe("build")
  expect(workflow.jobs.publish!.needs).toEqual(["plan", "build", "smoke"])
  expect(workflow.jobs.npm!.needs).toEqual(["plan", "publish"])
  for (const name of ["publish", "npm"]) expect(workflow.jobs[name]!.if).toContain("dry-run != 'true'")
})

test("native smoke runs the nightly archive checks without installing Bun", () => {
  expect(workflow.jobs.smoke!.strategy).toEqual(nightly.jobs.smoke!.strategy)
  const releaseRun = workflow.jobs.smoke!.steps.find((step) => step.name?.startsWith("Verify checksums"))!.run
  const nightlyRun = nightly.jobs.smoke!.steps.find((step) => step.name?.startsWith("Verify checksums"))!.run
  expect(releaseRun).toBe(nightlyRun)
  expect(workflow.jobs.smoke!.steps.some((step) => step.uses?.includes("setup-bun"))).toBe(false)
})

test("signed manifests are archived, verified on retry, and production signing cannot silently fall back", () => {
  const build = script("build")
  expect(build).toContain("AMIRA_RELEASE_ED25519_KEY (Ed25519 PKCS8 PEM) is required")
  const signing = workflow.jobs.build!.steps.find((step) => step.env?.SIGNING_KEY)!
  expect(signing.env!.SIGNING_KEY).toContain("secrets.AMIRA_RELEASE_ED25519_KEY")
  expect(signing.run).not.toContain("release-private")
  expect(signing.run).not.toContain("--key ")
  expect(signing.run).not.toContain("keygen")
  expect(signing.run).not.toContain("openssl")
  expect(signing.run).not.toMatch(/(?:printf|echo).*SIGNING_KEY.*>/)
  expect(signing.run).toContain("--key-env SIGNING_KEY")
  expect(signing.run).toContain("--ephemeral true")
  expect(build).toContain('-z "$SIGNING_KEY" && ( "$DRY_RUN" != true || "$PUBLISHED" == true )')
  expect(build).toContain("bun scripts/sign-manifest.ts generate")
  expect(build).toContain("bun scripts/sign-manifest.ts sign")
  expect(build).toContain("bun scripts/sign-manifest.ts verify")
  expect(build).toContain('cmp dist/manifest.json "$RUNNER_TEMP/published-manifest.json"')
  const archives = workflow.jobs.build!.steps.find((step) => step.with?.name === "release-archives")!
  expect(archives.with!.path).toContain("dist/manifest.json")
  expect(archives.with!.path).toContain("dist/manifest.json.sig")
  expect(archives.with!.path).toContain("dist/SHA256SUMS")
  expect(build).toContain("bun scripts/npm-pack.ts")
  expect(build).not.toContain("bun scripts/npm-pack.ts --version")
  expect(build).toContain('Bun.write("dist/build.json"')
})

test("published GitHub releases are only verified; fresh releases upload everything while still draft", () => {
  const publish = script("publish")
  const publishedBranch = publish.slice(publish.indexOf("if published:"), publish.indexOf("else:"))
  expect(publishedBranch).toContain("'cmp'")
  expect(publishedBranch).not.toContain("'edit'")
  expect(publishedBranch).not.toContain("'upload'")
  expect(publish.indexOf("'--draft',")).toBeLessThan(publish.indexOf("'upload'"))
  expect(publish.indexOf("'upload'")).toBeLessThan(publish.indexOf("'--draft=false'"))
  expect(publish).not.toMatch(/['"]--clobber['"]/)
  expect(publish).not.toContain("--cleanup-tag")
  const step = workflow.jobs.publish!.steps.find((item) => item.run?.includes("if published:"))!
  expect(step.env!.GH_REPO).toContain("github.repository")
})

test("manual dry runs validate all npm publications without credentials or write permissions", () => {
  const job = workflow.jobs["npm-dry-run"]!
  expect(job.needs).toEqual(["plan", "build", "smoke"])
  expect(job.if).toContain("dry-run == 'true'")
  expect(job.permissions).toBeUndefined()
  expect(script("npm-dry-run")).toContain("for directory in dist/npm/amira-* dist/npm/amira")
  expect(script("npm-dry-run")).toContain("--dry-run --provenance --access public")
  expect(script("npm-dry-run")).toContain("--ignore-scripts --offline")
  // The pinned npm goes into a job-private prefix; runners may not allow writes to the system one.
  for (const job of ["npm-dry-run", "npm"]) {
    expect(script(job)).toContain('npm install --global --prefix "$RUNNER_TEMP/npm" npm@11.6.2')
    expect(script(job)).not.toContain("npm install --global npm@")
  }
  expect(JSON.stringify(job)).not.toContain("secrets.")
})

test("npm publishes platform packages before main with provenance, public access, and safe registry checks", () => {
  const npm = script("npm")
  expect(workflow.jobs.npm!.permissions!["id-token"]).toBe("write")
  expect(npm).toContain("NPM_TOKEN")
  expect(npm.indexOf("result = subprocess.run(args")).toBeLessThan(npm.indexOf("_authToken="))
  expect(npm).toContain("DIST_TAG=latest")
  expect(npm).toContain("DIST_TAG=next")
  expect(npm).toContain("packages.sort(key=lambda item: (item[0] == 'amira', item[0]))")
  expect(npm).toContain("'--provenance', '--access', 'public'")
  expect(npm).toContain("https://registry.npmjs.org/")
  expect(npm).toContain("['curl', '-q', '--silent', '--show-error'")
  expect(npm).toContain("if status != '404':")
  expect(npm).not.toContain("npm view")
  expect(npm).not.toContain("--force")
})

test("nightly requires successful main CI for the selected SHA instead of duplicating checks", () => {
  const gate = nightly.jobs.ci
  expect(gate).toBeDefined()
  expect(nightly.jobs.check).toBeUndefined()
  expect(nightly.permissions).toEqual({ contents: "read" })
  expect(gate!.needs).toBe("plan")
  expect(gate!.if).toBe("needs.plan.outputs.changed == 'true'")
  expect(gate!.permissions).toEqual({ actions: "read" })
  expect(gate!.strategy).toBeUndefined()
  expect(gate!.outputs!.success).toBe(`\${{ steps.ci.outputs.success }}`)
  const step = gate!.steps.find((item) => item.id === "ci")!
  expect(step.env!.GH_TOKEN).toBe(`\${{ github.token }}`)
  expect(step.env!.SHA).toBe(`\${{ needs.plan.outputs.sha }}`)
  expect(step.run).toContain("actions/workflows/ci.yml/runs?head_sha=$SHA&branch=main&event=push")
  expect(step.run).toContain('echo "success=false" >> "$GITHUB_OUTPUT"')
  expect(step.run).toContain("if ! gh api")
  expect(step.run).toContain("::notice::")
  expect(step.run).toContain("exit 0")
  expect(JSON.stringify(gate)).not.toMatch(/bun run check|setup-bun|actions\/checkout/)
  expect(nightly.jobs.build!.needs).toEqual(["plan", "ci"])
  expect(nightly.jobs.build!.if).toBe("needs.ci.outputs.success == 'true'")
  expect(nightly.jobs.smoke!.needs).toBe("build")
  expect(nightly.jobs.publish!.needs).toEqual(["plan", "build", "smoke"])
  expect(nightly.jobs.publish!.permissions).toEqual({ contents: "write" })
})

test("nightly construction normalizes RC versions and discovery shares its policy with retention", () => {
  const plan = nightly.jobs.plan!.steps.map((step) => step.run ?? "").join("\n")
  const prune = nightly.jobs.publish!.steps.at(-1)!.run!
  expect(plan).toContain("from scripts.release_policy import nightly_releases, next_nightly_tag")
  expect(plan).toContain("next_nightly_tag(version, date, occupied)")
  expect(prune).toContain("from scripts.release_policy import nightly_releases")
  expect(prune).toContain("nightlies = nightly_releases(releases)")
})

test("separate server artifacts are built, signed, recovered immutably and uploaded without changing npm", () => {
  const build = script("build")
  const compile = workflow.jobs.build!.steps.find((step) =>
    step.name?.startsWith("Build separate Linux server"),
  )!
  expect(compile.if).toContain("published != 'true'")
  expect(compile.run).toContain(
    'bun scripts/build-server.ts --all --version "$VERSION" --channel "$CHANNEL" --build-id "$BUILD_ID"',
  )
  expect(compile.env!.BUILD_ID).toBe(`\${{ needs.plan.outputs.sha }}`)
  expect(build).toContain("--pattern 'amira-server-bun-linux-*'")
  expect(build).toContain("--pattern server-manifest.json --pattern server-manifest.json.sig")
  expect(build).toContain("bun scripts/server-manifest.ts verify --key-env SIGNING_KEY")
  expect(build).toContain(
    'bun scripts/server-manifest.ts recover --version "$VERSION" --channel "$CHANNEL" --target all --build-id "$BUILD_ID"',
  )
  expect(workflow.jobs.build!.steps.find((step) => step.env?.PUBLISHED)!.env!.BUILD_ID).toBe(
    `\${{ needs.plan.outputs.sha }}`,
  )
  expect(build).toContain("sha256sum --check SERVER_SHA256SUMS")
  const archives = workflow.jobs.build!.steps.find((step) => step.with?.name === "release-archives")!
  for (const file of [
    "amira-server-bun-linux-*",
    "SERVER_SHA256SUMS",
    "server-manifest.json",
    "server-manifest.json.sig",
  ]) {
    expect(archives.with!.path).toContain(`dist/${file}`)
  }
  const publish = script("publish")
  const publishedBranch = publish.slice(publish.indexOf("if published:"), publish.indexOf("else:"))
  expect(publishedBranch).toContain("server-manifest.json.sig")
  expect(publishedBranch).toContain("SERVER_SHA256SUMS")
  expect(publishedBranch).not.toContain("'upload'")
  const nightlyBuild = nightly.jobs.build!.steps.map((step) => step.run ?? "").join("\n")
  expect(nightlyBuild).toContain(
    'bun scripts/build-server.ts --all --version "$VERSION" --channel next --build-id "$BUILD_ID"',
  )
  expect(nightly.jobs.build!.steps.find((step) => step.env?.SIGNING_KEY)!.env!.BUILD_ID).toBe(
    `\${{ needs.plan.outputs.sha }}`,
  )
  expect(nightlyBuild).toContain("AMIRA_RELEASE_ED25519_KEY is required for server artifacts")
  expect(nightlyBuild).toContain("bun scripts/server-manifest.ts sign --key-env SIGNING_KEY")
  expect(nightlyBuild).not.toContain("--ephemeral")
  const nightlyPublish = nightly.jobs.publish!.steps.map((step) => step.run ?? "").join("\n")
  expect(nightlyPublish).toContain("dist/server-manifest.json dist/server-manifest.json.sig")
})

test("server CI compiles Linux production targets and an explicitly test-only native Windows target", async () => {
  const ci = Bun.YAML.parse(
    await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text(),
  ) as Workflow
  const server = ci.jobs.server!
  const run = server.steps.map((step) => step.run ?? "").join("\n")
  expect(run).toContain(
    "bun scripts/build-server.ts --all --build-id 0123456789abcdef0123456789abcdef01234567",
  )
  expect(run).toContain('for flag in ["--version-json", "--self-check"]')
  expect(run).toContain('"buildId"')
  expect(run).toContain("Server Linux ARM64 execution unverified: no native runner")
  expect(run).not.toContain("./dist/amira-server-bun-linux-arm64 --self-check")
  const windows = ci.jobs.check!.steps.find(
    (step) => step.name === "Compile a native Windows test-only server",
  )!
  expect(windows.if).toBe("runner.os == 'Windows'")
  expect(windows.run).toBe(
    "bun scripts/build-server.ts --native-windows-test --build-id 0123456789abcdef0123456789abcdef01234567",
  )
  for (const staged of [workflow, nightly]) {
    const smoke = staged.jobs.smoke!.steps.find((step) =>
      step.name?.startsWith("Verify and smoke the Linux x64 baseline server"),
    )!
    expect(smoke.if).toBe("runner.os == 'Linux'")
    expect(smoke.run).toContain('assert len(data) == artifact["size"]')
    expect(smoke.run).toContain('hashlib.sha256(data).hexdigest() == artifact["sha256"]')
    expect(smoke.run).toContain("--self-check")
    expect(smoke.run).toContain('export AMIRA_HOME="$RUNNER_TEMP/server-smoke/home/amira"')
    expect(smoke.run).toContain("Server Linux ARM64 execution unverified: no native runner")
  }
})

test("publication resolves the remote peeled tag immediately before creation and publication", () => {
  const publish = script("publish")
  expect(publish).toContain("from scripts.release_policy import verify_tag_commit")
  expect(publish.match(/verify_tag_commit\(os\.environ\['GITHUB_REPOSITORY'\]/g)).toHaveLength(3)
  expect(publish).toMatch(/verify_tag_commit\([^\n]+\)\n\s+subprocess\.run\(args, check=True\)/)
  const checkout = workflow.jobs.publish!.steps.find((step) => step.uses?.startsWith("actions/checkout@"))!
  expect(checkout.with!.ref).toContain("needs.plan.outputs.sha")
  expect(checkout.with!["persist-credentials"]).toBe(false)
})
