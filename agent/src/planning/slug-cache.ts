type SlugCacheState = "active" | "terminal";

const slugState = new WeakMap<object, SlugCacheState>();

export class PlanSlugCache {
  private cache = new WeakMap<object, string>();

  get(session: object): string | undefined {
    return this.cache.get(session);
  }

  set(session: object, slug: string): void {
    this.cache.set(session, slug);
  }

  delete(session: object): void {
    this.cache.delete(session);
    slugState.delete(session);
  }
}

export const planSlugCache = new PlanSlugCache();

export const slugCacheState = {
  markActive(session: object): void {
    slugState.set(session, "active");
  },
  markTerminal(session: object): void {
    slugState.set(session, "terminal");
  },
  getState(session: object): SlugCacheState | undefined {
    return slugState.get(session);
  },
};
