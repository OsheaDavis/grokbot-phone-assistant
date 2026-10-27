export const BLOCK_MESSAGE = "Sorry, this number cannot take your call. Goodbye.";
export const SPAM_MESSAGE = "This number is not accepting this call. Goodbye.";
export const UNAVAILABLE_MESSAGE = "Sorry, this assistant is temporarily unavailable. Please try again later.";

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function connectStreamTwiml(streamUrl: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "  <Connect>",
    `    <Stream url="${escapeXml(streamUrl)}"/>`,
    "  </Connect>",
    "</Response>",
  ].join("\n");
}

export function hangupTwiml(message: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Say>${escapeXml(message)}</Say>`,
    "  <Hangup/>",
    "</Response>",
  ].join("\n");
}
