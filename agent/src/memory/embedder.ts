/**
 * APIEmbedder — calls an OpenAI-compatible embeddings API.
 */

import type { Embedder, EmbeddingConfig } from "../types/v04-contracts.js";
import type { QlayBotConfig } from "../config.js";

export class APIEmbedder implements Embedder {
  readonly dimensions: number;
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(opts: { baseUrl: string; apiKey: string; model: string; dimensions: number }) {
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.dimensions = opts.dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    const resp = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    const json = await resp.json() as { data: Array<{ embedding: number[] }> };
    return new Float32Array(json.data[0].embedding);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const resp = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    const json = await resp.json() as { data: Array<{ embedding: number[] }> };
    return json.data.map((d) => new Float32Array(d.embedding));
  }
}

export function createEmbedder(config: QlayBotConfig): Embedder | null {
  const emb = config.embedding;
  if (!emb.baseUrl || !emb.apiKey || !emb.model) return null;
  return new APIEmbedder({
    baseUrl: emb.baseUrl,
    apiKey: emb.apiKey,
    model: emb.model,
    dimensions: emb.dimensions,
  });
}
