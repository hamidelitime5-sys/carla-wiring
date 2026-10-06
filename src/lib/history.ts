// src/lib/history.ts : annuler / rétablir (instantanés texte de l'état).
export class History {
  private past: string[] = [];
  private future: string[] = [];
  constructor(private present: string, private readonly limit = 60) {}

  /** Enregistre un nouvel état s'il diffère. Renvoie true si quelque chose a changé. */
  commit(state: string): boolean {
    if (state === this.present) return false;
    this.past.push(this.present);
    if (this.past.length > this.limit) this.past.shift();
    this.present = state;
    this.future = [];
    return true;
  }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  undo(): string | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(this.present);
    this.present = prev;
    return prev;
  }
  redo(): string | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(this.present);
    this.present = next;
    return next;
  }
  /** Nouvel état de départ (ex. au chargement d'un projet) sans l'effacer de l'historique. */
  get current(): string { return this.present; }
}
