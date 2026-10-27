/**
 * The outbound opener now lives in the context card (examples/call-cards and
 * $DATA_DIR/call-cards), spoken by src/outbound/turn.ts. This module keeps only
 * the donor-pitch guard used by card validation and the approval checks.
 */

/** Collapsed so spacing or a sign cannot hide the inbound donor sentence. */
export function carriesDonorPitch(value: string): boolean {
  const collapsed = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (collapsed.includes("xmoney")) return true;
  if (collapsed.includes("exampleowner")) return true;
  if (collapsed.includes("givefreely")) return true;
  return false;
}
