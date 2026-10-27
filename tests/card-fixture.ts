import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CardStore, cardHash } from "../src/outbound/card.js";

/** The committed example card (fake number only). Tests run from the repo root. */
export function exampleCard(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "examples", "call-cards", "example-returns-v1.json"), "utf8")) as Record<string, unknown>;
}

export const EXAMPLE_CARD_ID = "example-returns-v1";
export const EXAMPLE_CARD_HASH = cardHash(exampleCard());

/** Writes a card and the number map into <dataDir>/call-cards. Numbers are fake 555s. */
export function installCard(
  dataDir: string,
  number = "+12025550100",
  card: Record<string, unknown> = exampleCard(),
): { cardId: string; cardHash: string; dir: string } {
  const dir = path.join(dataDir, "call-cards");
  fs.mkdirSync(dir, { recursive: true });
  const id = String(card.id);
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(card, null, 2));
  const ref = (card.callee as { numberRef?: string } | undefined)?.numberRef ?? "EXAMPLE_PARTNER";
  fs.writeFileSync(path.join(dir, "numbers.json"), JSON.stringify({ [ref]: number }));
  return { cardId: id, cardHash: cardHash(card), dir };
}

export function tempCardStore(number = "+12025550100"): { store: CardStore; dataDir: string; cardId: string; cardHash: string; dir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-cards-"));
  const installed = installCard(dataDir, number);
  return { store: CardStore.forDataDir(dataDir), dataDir, ...installed };
}
