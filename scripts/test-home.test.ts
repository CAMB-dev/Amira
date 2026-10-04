import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const owned: string[] = []
afterEach(() => {
  for (const directory of owned.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "amira-home-guard-test-"))
  owned.push(directory)
  const originalHome = path.join(directory, "original")
  const inherited = path.join(directory, "inherited")
  const protectedHome = path.join(originalHome, ".amira")
  mkdirSync(protectedHome, { recursive: true })
  mkdirSync(inherited)
  writeFileSync(path.join(protectedHome, "existing"), "unchanged")
  writeFileSync(path.join(inherited, "existing"), "unchanged")
  const preload = path.join(directory, "preload.ts")
  const entry = path.join(directory, "entry.test.ts")
  const helper = pathToFileURL(path.join(import.meta.dir, "test-home.ts")).href
  writeFileSync(preload, `import { isolateTestHome } from ${JSON.stringify(helper)}; isolateTestHome();`)
  return {
    directory,
    protectedHome,
    inherited,
    run(source: string | string[], testRunner = false, parallel: boolean | "shared" = false) {
      const entries = (Array.isArray(source) ? source : [source]).map((contents, index) => {
        const filename = index === 0 ? entry : path.join(directory, `entry-${index}.test.ts`)
        writeFileSync(filename, contents)
        return filename
      })
      if (testRunner) {
        writeFileSync(
          preload,
          `import { afterAll } from "bun:test"; import { isolateTestHome } from ${JSON.stringify(helper)}; afterAll(isolateTestHome());`,
        )
      }
      writeFileSync(path.join(directory, "bunfig.toml"), '[test]\npreload = ["./preload.ts"]\n')
      const workers =
        parallel === "shared" ? ["--parallel=1", "--no-isolate"] : parallel ? ["--parallel=2"] : []
      const command = testRunner
        ? [process.execPath, "test", ...workers, ...entries]
        : [process.execPath, "--preload", preload, entry]
      const result = Bun.spawnSync(command, {
        cwd: directory,
        env: {
          ...process.env,
          HOME: originalHome,
          USERPROFILE: originalHome,
          AMIRA_HOME: inherited,
          AMIRA_MODEL: "must-not-leak",
          AMIRA_LIVE_GUARD_TEST: "preserved",
          GUARD_FIXTURE: directory,
          GUARD_PROTECTED: protectedHome,
          GUARD_INHERITED: inherited,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      })
      return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
    },
  }
}

// Each test starts bun subprocesses (30 s limit each); under a loaded machine 5 s is too short.
setDefaultTimeout(30_000)

describe("test home isolation", () => {
  test("redirects every home, preserves executable lookup, and removes only its own directory", () => {
    const files = fixture()
    const result = files.run(`
      import { strict as assert } from "node:assert";
      import fs from "node:fs";
      import os from "node:os";
      import path from "node:path";
      const env = process.env;
      assert.equal(env.HOME, env.USERPROFILE);
      assert.equal(os.homedir(), env.HOME);
      assert.equal(env.AMIRA_HOME, path.join(env.HOME, ".amira"));
      assert.equal(env.XDG_CONFIG_HOME, path.join(env.HOME, ".config"));
      assert.equal(env.AMIRA_MODEL, undefined);
      assert.equal(env.AMIRA_LIVE_GUARD_TEST, "preserved");
      assert.equal(env.PATH, ${JSON.stringify(process.env.PATH)});
      if (process.platform === "win32") assert.equal(env.HOMEDRIVE + env.HOMEPATH, env.HOME);
      fs.writeFileSync(path.join(env.AMIRA_HOME, "allowed"), "yes");
      fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, "allowed"), "yes");
      console.log(env.HOME);
    `)
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(() => readFileSync(path.join(result.stdout.trim(), ".amira", "allowed"))).toThrow()
    expect(readFileSync(path.join(files.protectedHome, "existing"), "utf8")).toBe("unchanged")
    expect(readFileSync(path.join(files.inherited, "existing"), "utf8")).toBe("unchanged")
  })

  test("blocks sync, callback, promise, named imports and Bun.write even when errors are caught", () => {
    const files = fixture()
    const result = files.run(`
      import fs, { writeFileSync } from "node:fs";
      import fsp, { writeFile } from "node:fs/promises";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const root = process.env.GUARD_PROTECTED;
      const file = path.join(root, "existing");
      const other = path.join(process.env.GUARD_FIXTURE, "source");
      fs.writeFileSync(other, "source");
      const attempts = [
        () => writeFileSync(file, "changed"),
        () => fs.appendFileSync(Buffer.from(file), "changed"),
        () => fs.mkdirSync(path.join(root, "new", "nested"), { recursive: true }),
        () => fs.mkdtempSync(path.join(root, "temp-")),
        () => fs.writeFile(file, "changed", () => {}),
        () => writeFile(pathToFileURL(file), "changed"),
        () => fsp.appendFile(file, "changed"),
        () => fs.openSync(file, "r+"),
        () => fs.open(file, "w", () => {}),
        () => fsp.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT),
        () => fs.copyFileSync(other, file),
        () => fsp.cp(other, file),
        () => fs.renameSync(file, other),
        () => fs.renameSync(other, file),
        () => fs.unlinkSync(file),
        () => fs.rmSync(root, { recursive: true }),
        () => fs.rmSync(path.dirname(root), { recursive: true }),
        () => fs.rmdirSync(root),
        () => fs.truncateSync(file, 0),
        () => fs.chmodSync(file, 0o600),
        () => fs.utimesSync(file, new Date(), new Date()),
        () => fs.linkSync(file, path.join(process.env.GUARD_FIXTURE, "hardlink")),
        () => fs.symlinkSync(other, path.join(root, "symlink")),
        () => fs.createWriteStream(file),
        () => Bun.write(file, "changed"),
        () => Bun.write(Bun.file(file), "changed"),
        () => fs.writeFileSync(path.join(process.env.GUARD_INHERITED, "existing"), "changed"),
      ];
      const fd = fs.openSync(file, "r");
      const handle = await fsp.open(file, "r");
      attempts.push(
        () => fs.writeSync(fd, "changed"),
        () => handle.writeFile("changed"),
        () => fsp.writeFile(handle, "changed"),
        () => fs.createWriteStream(null, { fd }),
      );
      let caught = 0;
      for (const attempt of attempts) {
        try { await attempt(); } catch (error) {
          if (!String(error).includes("Test home guard blocked")) throw error;
          caught++;
        }
      }
      fs.closeSync(fd);
      await handle.close();
      console.log(caught + "/" + attempts.length);
    `)
    expect(result.stdout.trim()).toBe("31/31")
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Test home guard blocked")
    expect(readFileSync(path.join(files.protectedHome, "existing"), "utf8")).toBe("unchanged")
    expect(readFileSync(path.join(files.inherited, "existing"), "utf8")).toBe("unchanged")
  })

  test("blocks BunFile writers and deletion without blocking reads or isolated-home writers", () => {
    const files = fixture()
    const result = files.run(`
      import { strict as assert } from "node:assert";
      import path from "node:path";
      const file = Bun.file(path.join(process.env.GUARD_PROTECTED, "existing"));
      assert.equal(await file.text(), "unchanged");
      const writer = Bun.file(path.join(process.env.AMIRA_HOME, "job.log")).writer();
      writer.write("allowed");
      await writer.end();
      assert.equal(await Bun.file(path.join(process.env.AMIRA_HOME, "job.log")).text(), "allowed");
      await Bun.file(path.join(process.env.AMIRA_HOME, "job.log")).delete();
      let caught = 0;
      for (const attempt of [() => file.writer(), () => file.delete()]) {
        try { await attempt(); }
        catch (error) { if (!String(error).includes("Test home guard blocked")) throw error; caught++; }
      }
      console.log(caught);
    `)
    expect(result.stdout.trim()).toBe("2")
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Test home guard blocked BunFile.writer")
    expect(result.stderr).toContain("Test home guard blocked BunFile.delete")
    expect(readFileSync(path.join(files.protectedHome, "existing"), "utf8")).toBe("unchanged")
  })

  test("blocks recursive copies into a protected home's parent", () => {
    const files = fixture()
    const result = files.run(`
      import fs from "node:fs";
      import fsp from "node:fs/promises";
      import path from "node:path";
      const root = process.env.GUARD_PROTECTED;
      const source = path.join(process.env.GUARD_FIXTURE, "source");
      fs.mkdirSync(path.join(source, ".amira"), { recursive: true });
      fs.writeFileSync(path.join(source, ".amira", "existing"), "changed");
      let caught = 0;
      for (const attempt of [
        () => fs.cpSync(source, path.dirname(root), { recursive: true }),
        () => fsp.cp(source, path.dirname(root), { recursive: true }),
        () => new Promise((resolve, reject) => fs.cp(source, path.dirname(root), { recursive: true }, error => error ? reject(error) : resolve())),
      ]) {
        try { await attempt(); }
        catch (error) { if (!String(error).includes("Test home guard blocked")) throw error; caught++; }
      }
      console.log(caught);
    `)
    expect(result.stdout.trim()).toBe("3")
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Test home guard blocked cpSync:")
    expect(result.stderr).toContain("Test home guard blocked cp:")
    expect(readFileSync(path.join(files.protectedHome, "existing"), "utf8")).toBe("unchanged")
  })

  test("fails a passing Bun test run when application code swallows a write violation", () => {
    const files = fixture()
    const result = files.run(
      `
      import { test, expect } from "bun:test";
      import fs, { writeFileSync } from "node:fs";
      test("caught", () => {
        expect(process.env.AMIRA_HOME).not.toBe(process.env.GUARD_INHERITED);
        expect(fs.writeFileSync).toBe(writeFileSync);
        console.log("OWNED_HOME=" + process.env.HOME);
        writeFileSync(process.env.AMIRA_HOME + "/owned", "yes");
        try { writeFileSync(process.env.GUARD_INHERITED + "/existing", "changed"); } catch {}
        expect(true).toBe(true);
      });
    `,
      true,
    )
    expect(result.stderr).toContain("Test home guard blocked writeFileSync")
    expect(result.stderr).toContain("1 pass")
    expect(result.code).toBe(1)
    const home = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("OWNED_HOME="))
      ?.slice("OWNED_HOME=".length)
    expect(home).toBeDefined()
    expect(() => readFileSync(path.join(home ?? "", ".amira", "owned"))).toThrow()
    expect(readFileSync(path.join(files.inherited, "existing"), "utf8")).toBe("unchanged")
  })

  test.each([false, true, "shared"] as const)(
    "keeps default homes usable across two test files (parallel=%s)",
    (parallel) => {
      const files = fixture()
      const sources = ["first", "second"].map(
        (name) => `
      import { test, expect } from "bun:test";
      import fs from "node:fs";
      import path from "node:path";
      test(${JSON.stringify(name)}, async () => {
        await Bun.sleep(10);
        const file = path.join(process.env.AMIRA_HOME, ${JSON.stringify(name)});
        fs.writeFileSync(file, "allowed");
        expect(fs.readFileSync(file, "utf8")).toBe("allowed");
        console.log("OWNED_HOME=" + process.env.HOME);
      });
    `,
      )
      const result = files.run(sources, true, parallel)
      expect(result.code).toBe(0)
      expect(result.stderr).toContain("2 pass")
      expect(result.stderr).toContain("0 fail")
      const homes = `${result.stdout}\n${result.stderr}`
        .split(/\r?\n/)
        .filter((line) => line.startsWith("OWNED_HOME="))
        .map((line) => line.slice("OWNED_HOME=".length))
      expect(homes).toHaveLength(2)
      for (const home of homes) expect(existsSync(home)).toBe(false)
    },
  )

  test("does not monitor independent processes; children need their own preload for explicit paths", () => {
    const files = fixture()
    const result = files.run(`
      const source = 'require("node:fs").writeFileSync(process.env.GUARD_INHERITED + "/existing", "independent")';
      const child = Bun.spawnSync([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
      if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    `)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe("")
    expect(readFileSync(path.join(files.inherited, "existing"), "utf8")).toBe("independent")
  })

  test("allows removing and renaming external aliases without changing the protected home", () => {
    const files = fixture()
    const result = files.run(`
      import fs from "node:fs";
      import fsp from "node:fs/promises";
      import path from "node:path";
      const alias = path.join(process.env.GUARD_FIXTURE, "alias");
      const renamed = alias + "-renamed";
      const operations = [
        () => fs.unlinkSync(alias),
        () => fsp.unlink(alias),
        () => fs.rmSync(alias, { recursive: true }),
        () => fsp.rm(alias, { recursive: true }),
        async () => { await fsp.rename(alias, renamed); fs.unlinkSync(renamed); },
      ];
      if (process.platform === "win32") operations.push(() => fs.rmdirSync(alias));
      for (const operation of operations) {
        fs.symlinkSync(process.env.GUARD_PROTECTED, alias, process.platform === "win32" ? "junction" : "dir");
        await operation();
      }
      console.log("removed aliases");
    `)
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe("removed aliases")
    expect(readFileSync(path.join(files.protectedHome, "existing"), "utf8")).toBe("unchanged")
  })

  test.skipIf(process.platform === "win32")("resolves symlinks before parent segments on POSIX", () => {
    const files = fixture()
    // This directory must exist before the guard is installed.
    mkdirSync(path.join(files.protectedHome, "nested"))
    const result = files.run(`
      import fs from "node:fs";
      import path from "node:path";
      const alias = path.join(process.env.GUARD_FIXTURE, "alias");
      fs.symlinkSync(path.join(process.env.GUARD_PROTECTED, "nested"), alias);
      let caught = 0;
      try { fs.writeFileSync(alias + "/../existing", "changed"); }
      catch (error) { if (!String(error).includes("Test home guard blocked")) throw error; caught++; }
      console.log(caught);
    `)
    expect(result.stdout.trim()).toBe("1")
    expect(result.code).toBe(1)
    expect(readFileSync(path.join(files.protectedHome, "existing"), "utf8")).toBe("unchanged")
  })

  test("resolves existing-parent symlinks and Windows case without blocking sibling paths", () => {
    const files = fixture()
    const result = files.run(`
      import fs from "node:fs";
      import path from "node:path";
      const root = process.env.GUARD_PROTECTED;
      const sibling = root + "-allowed";
      fs.mkdirSync(sibling);
      fs.writeFileSync(path.join(sibling, "allowed"), "yes");
      fs.copyFileSync(path.join(root, "existing"), path.join(sibling, "copy"));
      const alias = path.join(process.env.GUARD_FIXTURE, "alias");
      fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
      let caught = 0;
      for (const attempt of [
        () => fs.mkdirSync(path.join(alias, "new", "nested"), { recursive: true }),
        () => fs.unlinkSync(path.join(alias, "existing")),
        () => fs.renameSync(path.join(alias, "existing"), path.join(sibling, "renamed")),
      ]) {
        try { attempt(); }
        catch (error) { if (!String(error).includes("Test home guard blocked")) throw error; caught++; }
      }
      if (process.platform === "win32") {
        try { fs.writeFileSync(path.join(root.toUpperCase(), "existing"), "changed"); }
        catch (error) { if (!String(error).includes("Test home guard blocked")) throw error; caught++; }
      }
      console.log(caught);
    `)
    expect(result.code).toBe(1)
    expect(result.stdout.trim()).toBe(process.platform === "win32" ? "4" : "3")
    expect(readFileSync(path.join(`${files.protectedHome}-allowed`, "allowed"), "utf8")).toBe("yes")
    expect(readFileSync(path.join(`${files.protectedHome}-allowed`, "copy"), "utf8")).toBe("unchanged")
  })
})
