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
  }
}

export const planSlugCache = new PlanSlugCache();
