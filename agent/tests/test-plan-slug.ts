import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmpDirs: string[] = [];

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "qlaybot-plan-slug-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("PlanSlugCache", () => {
  it("stores, retrieves, isolates, and deletes per-session slugs", async () => {
    const { PlanSlugCache } = await import("../src/planning/slug-cache.js");

    const cache = new PlanSlugCache();
    const session = {};
    const otherSession = {};

    expect(cache.get(session)).toBeUndefined();

    cache.set(session, "brave-lantern");

    expect(cache.get(session)).toBe("brave-lantern");
    expect(cache.get(otherSession)).toBeUndefined();

    cache.delete(session);

    expect(cache.get(session)).toBeUndefined();
  });
});

describe("slugCacheState", () => {
  it("tracks active vs terminal state and clears with delete", async () => {
    const { PlanSlugCache, slugCacheState } = await import(
      "../src/planning/slug-cache.js"
    );

    const cache = new PlanSlugCache();
    const session = {};

    cache.set(session, "ember-bridge");
    slugCacheState.markTerminal(session);
    expect(slugCacheState.getState(session)).toBe("terminal");

    slugCacheState.markActive(session);
    expect(slugCacheState.getState(session)).toBe("active");

    cache.delete(session);
    expect(slugCacheState.getState(session)).toBeUndefined();
  });
});

describe("generateWordSlug", () => {
  it("returns two-word lowercase slugs with basic entropy", async () => {
    const { generateWordSlug } = await import(
      "../src/planning/word-slug.js"
    );

    const slugs = Array.from({ length: 1000 }, () => generateWordSlug());

    expect(slugs.every((slug) => /^[a-z]+-[a-z]+$/.test(slug))).toBe(true);
    expect(slugs.every((slug) => !slug.startsWith("plan-"))).toBe(true);
    expect(new Set(slugs).size).toBeGreaterThanOrEqual(500);
  });
});

describe("PlanManager enterPlanMode (T24 a/b/c/f)", () => {
  it("creates a word-slug plan file immediately on a fresh session", async () => {
    const wordSlug = await import("../src/planning/word-slug.js");
    vi.spyOn(wordSlug, "generateWordSlug").mockReturnValue("brave-lantern");

    const { PlanManager } = await import("../src/planning/index.js");

    const workspaceDir = makeWorkspace();
    const planManager = new PlanManager(workspaceDir);
    const plan = planManager.enterPlanMode("Draft a routing plan");

    expect(plan).not.toBeNull();
    expect(plan).toMatchObject({
      id: "brave-lantern",
      filePath: join(workspaceDir, "plans", "brave-lantern.md"),
    });
    expect(existsSync(join(workspaceDir, "plans", "brave-lantern.md"))).toBe(
      true,
    );
  });

  it("reuses the cached active slug within the same session and preserves file contents", async () => {
    const wordSlug = await import("../src/planning/word-slug.js");
    vi.spyOn(wordSlug, "generateWordSlug").mockReturnValue("river-gate");

    const { PlanManager } = await import("../src/planning/index.js");
    const { planSlugCache } = await import("../src/planning/slug-cache.js");

    const workspaceDir = makeWorkspace();
    const planManager = new PlanManager(workspaceDir);
    const firstPlan = planManager.enterPlanMode("Initial draft");
    expect(firstPlan).not.toBeNull();

    writeFileSync(firstPlan!.filePath, "plan draft v1", "utf-8");

    const secondPlan = planManager.enterPlanMode("Replan with feedback");

    expect(secondPlan).not.toBeNull();
    expect(secondPlan!.id).toBe(firstPlan!.id);
    expect(secondPlan!.filePath).toBe(firstPlan!.filePath);
    expect(readFileSync(firstPlan!.filePath, "utf-8")).toBe("plan draft v1");
    expect(planSlugCache.get(planManager.sessionKey)).toBe("river-gate");
  });

  it("returns a structured collision error after 10 slug retries", async () => {
    const wordSlug = await import("../src/planning/word-slug.js");
    vi.spyOn(wordSlug, "generateWordSlug").mockReturnValue("aaa-bbb");

    const { PlanManager } = await import("../src/planning/index.js");
    const { createEnterPlanModeTool } = await import("../src/tools/plan.js");

    const workspaceDir = makeWorkspace();
    mkdirSync(join(workspaceDir, "plans"), { recursive: true });
    writeFileSync(join(workspaceDir, "plans", "aaa-bbb.md"), "taken", "utf-8");

    const planManager = new PlanManager(workspaceDir);
    const tool = createEnterPlanModeTool(planManager);
    const result = await tool.execute("tool-call-1", {
      task: "Collision probe",
      reason: "Verify structured exhaustion handling",
    });

    const body = JSON.parse(result.content[0]!.text as string);

    expect(body.status).toBe("error");
    expect(body.message).toContain("slug collision after 10 retries");
  });
});

describe("plan slug reset on abandon (T24 d.2)", () => {
  it("deletes the cached slug and emits terminal abandon marker on exit_plan_mode({approved:false})", async () => {
    const wordSlug = await import("../src/planning/word-slug.js");
    vi.spyOn(wordSlug, "generateWordSlug")
      .mockReturnValueOnce("ember-bridge")
      .mockReturnValueOnce("silver-grove");

    const { PlanManager } = await import("../src/planning/index.js");
    const { planSlugCache } = await import("../src/planning/slug-cache.js");
    const {
      TranscriptMarkerEmitter,
      setTranscriptMarkerEmitter,
    } = await import("../src/events/marker-emitter.js");
    const { createExitPlanModeTool } = await import("../src/tools/plan.js");

    const workspaceDir = makeWorkspace();
    const planManager = new PlanManager(workspaceDir);
    const emitter = new TranscriptMarkerEmitter();
    const markers: any[] = [];
    emitter.on("marker", (marker) => markers.push(marker));
    setTranscriptMarkerEmitter(planManager.sessionKey, emitter);

    const firstPlan = planManager.enterPlanMode("First draft");
    expect(firstPlan).not.toBeNull();
    expect(planSlugCache.get(planManager.sessionKey)).toBe("ember-bridge");

    const exitTool = createExitPlanModeTool(planManager);
    const result = await exitTool.execute("tool-call-2", {
      approved: false,
      summary: "Abandon this draft",
    });
    const body = JSON.parse(result.content[0]!.text as string);

    expect(body.status).toBe("plan_abandoned");
    expect(planSlugCache.get(planManager.sessionKey)).toBeUndefined();
    expect(markers).toContainEqual(
      expect.objectContaining({
        type: "plan_rejected",
        action: "abandon",
        feedback: "abandoned",
      }),
    );

    const secondPlan = planManager.enterPlanMode("Fresh draft after abandon");
    expect(secondPlan).not.toBeNull();
    expect(secondPlan!.id).toBe("silver-grove");
  });
});
