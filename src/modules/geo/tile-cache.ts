/**
 * Least-recently-used cache bounded by total size, for generated vector
 * tiles. It lives in the api process: enough for one instance, and every
 * tile is also cached by the browser because its URL carries the data version.
 */
export class TileCache {
  private readonly entries = new Map<string, Buffer>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(key: string): Buffer | undefined {
    const tile = this.entries.get(key);
    if (tile) {
      // Re-insert: a Map iterates in insertion order, so the oldest entry is the first.
      this.entries.delete(key);
      this.entries.set(key, tile);
    }
    return tile;
  }

  set(key: string, tile: Buffer): void {
    if (tile.length > this.maxBytes) return;
    const previous = this.entries.get(key);
    if (previous) {
      this.bytes -= previous.length;
      this.entries.delete(key);
    }
    this.entries.set(key, tile);
    this.bytes += tile.length;
    for (const [oldest, value] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.bytes -= value.length;
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
