/**
 * Stage 1 envelope. It holds nothing. The call does not read it.
 * A later slice may put ticked values here. This stub has no values and
 * no read path that returns one.
 */
export interface EmptyEnvelope {
  readonly slots: Readonly<Record<string, never>>;
}

export function emptyEnvelope(): EmptyEnvelope {
  return { slots: {} };
}

/** Always throws. Stage 1 has nothing to release, and the call must not ask. */
export function readEnvelope(envelope: EmptyEnvelope, slot: string): never {
  const empty = Object.keys(envelope.slots).length;
  const asked = typeof slot === "string" ? slot.length : 0;
  throw new Error(`stage 1 envelope is empty (${empty}) and cannot be read (${asked})`);
}
