export type IngressEvent = { kind: string; [key: string]: unknown };

/** Wait on observed boundaries, never a guessed delay after starting the native process. */
export class IngressEvents {
  readonly rows: IngressEvent[] = [];
  readonly #listeners = new Set<() => void>();
  readonly #observers = new Set<(event: IngressEvent) => void>();

  listen(observer: (event: IngressEvent) => void): () => void {
    this.#observers.add(observer);
    return () => {
      this.#observers.delete(observer);
    };
  }

  record(event: IngressEvent): void {
    this.rows.push(event);
    for (const observer of this.#observers) observer(event);
    for (const listener of this.#listeners) listener();
  }

  wait(predicate: (event: IngressEvent) => boolean, after = 0): Promise<IngressEvent> {
    const found = this.rows.slice(after).find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const inspect = () => {
        const row = this.rows.slice(after).find(predicate);
        if (!row) return;
        clearTimeout(timer);
        this.#listeners.delete(inspect);
        resolve(row);
      };
      const timer = setTimeout(() => {
        this.#listeners.delete(inspect);
        reject(new Error(`Native ingress boundary timed out; recent events: ${JSON.stringify(this.rows.slice(-12))}`));
      }, 20_000);
      this.#listeners.add(inspect);
      inspect();
    });
  }
}
