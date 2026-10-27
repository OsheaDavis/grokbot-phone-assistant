/** Same end-of-call rule as inbound. These do not clear mid-call. */
export type OutboundFlag = "injection_attempt" | "money_related" | "possible_scam";

export interface OutboundFlagLatch {
  flags: OutboundFlag[];
}

export function createFlagLatch(): OutboundFlagLatch {
  return { flags: [] };
}

export function raiseOutboundFlag(state: OutboundFlagLatch, flag: OutboundFlag): void {
  if (!state.flags.includes(flag)) state.flags.push(flag);
}

/**
 * A later turn may replace its own text. Raised flags stay until the call
 * ends. Dropping a source does not drop the flag.
 */
export function correctOutboundTurn(state: OutboundFlagLatch): readonly OutboundFlag[] {
  return state.flags.slice();
}

/** Call end. The next call uses a new latch and starts with no flags. */
export function endOutboundCall(state: OutboundFlagLatch): void {
  state.flags.length = 0;
}
