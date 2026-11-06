import type { PublicArtifact, PublicArtifactKind } from "@live-interview/core";
export class ArtifactCache {
  private cache = new Map<string, Promise<PublicArtifact | null>>();
  private inFlight = new Map<string, Promise<PublicArtifact>>();
  private listeners = new Set<(saved: PublicArtifact) => void>();
  /** Called after every save, by any path (generation, a person's edit), with the artifact as saved. */
  subscribe(listener: (saved: PublicArtifact) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  constructor(
    private client: {
      getArtifact: (
        meetingId: string,
        kind: PublicArtifactKind,
        recordRevision: number,
      ) => Promise<PublicArtifact | null>;
      getLatestArtifact?: (
        meetingId: string,
        kind: PublicArtifactKind,
        recordRevision: number,
      ) => Promise<PublicArtifact | null>;
      saveArtifact: (artifact: PublicArtifact) => Promise<PublicArtifact>;
    },
  ) {}
  private key(id: string, kind: PublicArtifactKind, revision: number) {
    return JSON.stringify([id, kind, revision]);
  }
  load(
    id: string,
    kind: PublicArtifactKind,
    revision: number,
  ): Promise<PublicArtifact | null> {
    const key = this.key(id, kind, revision);
    let value = this.cache.get(key);
    if (!value) {
      value = this.client.getArtifact(id, kind, revision).catch((error) => {
        this.cache.delete(key);
        throw error;
      });
      this.cache.set(key, value);
    }
    return value;
  }
  /** The artifact for this record revision, else the newest saved for an earlier one. */
  async loadLatest(
    id: string,
    kind: PublicArtifactKind,
    revision: number,
  ): Promise<PublicArtifact | null> {
    const exact = await this.load(id, kind, revision);
    if (exact || !this.client.getLatestArtifact) return exact;
    return this.client.getLatestArtifact(id, kind, revision);
  }
  async saveGenerated(artifact: PublicArtifact) {
    const previous = await this.load(
      artifact.meetingId,
      artifact.kind,
      artifact.recordRevision,
    );
    if (previous?.humanEdited) throw Error("humanEdited");
    return this.save({ ...artifact, updatedAtMs: previous?.updatedAtMs ?? 0 });
  }
  async save(artifact: PublicArtifact) {
    const saved = await this.client.saveArtifact(artifact);
    this.cache.set(
      this.key(saved.meetingId, saved.kind, saved.recordRevision),
      Promise.resolve(saved),
    );
    for (const listener of this.listeners) listener(saved);
    return saved;
  }
  generateCached(
    identity: Pick<PublicArtifact, "meetingId" | "kind" | "recordRevision">,
    generate: () => Promise<
      Pick<PublicArtifact, "text" | "evidence" | "items" | "omitted">
    >,
    force = false,
  ): Promise<PublicArtifact> {
    const key = this.key(
      identity.meetingId,
      identity.kind,
      identity.recordRevision,
    );
    const running = this.inFlight.get(key);
    if (running) return running;
    const request = (async () => {
      const saved = await this.load(
        identity.meetingId,
        identity.kind,
        identity.recordRevision,
      );
      if (saved?.humanEdited || (saved?.status === "ready" && !force))
        return saved;
      if (saved?.status !== "ready")
        await this.saveGenerated({
          ...identity,
          text: "",
          evidence: [],
          status: "pending",
          humanEdited: false,
          updatedAtMs: saved?.updatedAtMs ?? 0,
        });
      try {
        const result = await generate();
        return await this.saveGenerated({
          ...identity,
          ...result,
          status: "ready",
          humanEdited: false,
          updatedAtMs: 0,
        });
      } catch (error) {
        if (saved?.status !== "ready")
          await this.saveGenerated({
            ...identity,
            text: "",
            evidence: [],
            status: "failed",
            humanEdited: false,
            updatedAtMs: 0,
          }).catch(() => {});
        throw error;
      }
    })();
    this.inFlight.set(key, request);
    void request.finally(() => this.inFlight.delete(key)).catch(() => {});
    return request;
  }
  invalidate(id: string, kind: PublicArtifactKind, revision: number) {
    this.cache.delete(this.key(id, kind, revision));
  }
}
export function groundedEvidence(
  evidence: string[],
  allowed: string[],
  required = false,
): string[] {
  const found = [...new Set(evidence.filter((id) => allowed.includes(id)))];
  if (required && !found.length) throw Error("ungrounded");
  return found;
}
