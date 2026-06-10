import type { ModelCatalogDraft, ModelSource } from "./types";

export class ModelSourceRegistry {
  private readonly sources: ModelSource[];

  constructor(sources?: ModelSource[]) {
    this.sources = sources ? [...sources] : [];
  }

  register(source: ModelSource): void {
    this.sources.push(source);
  }

  supporting(draft: ModelCatalogDraft): ModelSource[] {
    return this.sources.filter((source) => source.supports(draft));
  }

  list(): ModelSource[] {
    return [...this.sources];
  }
}
