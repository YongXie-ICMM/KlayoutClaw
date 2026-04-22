import { describe, expect, it } from "vitest";

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
