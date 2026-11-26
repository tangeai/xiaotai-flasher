import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  LIERDA_AGENTBOOT_BYTES, LIERDA_AGENTBOOT_PATH, LIERDA_AGENTBOOT_SHA256,
} from '../src/lierda-agentboot.mjs';

export const lierdaAgentBootInfo = {
  bytes: LIERDA_AGENTBOOT_BYTES,
  sha256: LIERDA_AGENTBOOT_SHA256,
};

function validLierdaAgentBoot(directory, expected = lierdaAgentBootInfo) {
  const path = join(directory, LIERDA_AGENTBOOT_PATH);
  const file = lstatSync(path, { throwIfNoEntry: false });
  return file?.isFile() === true && file.size === expected?.bytes &&
    createHash('sha256').update(readFileSync(path)).digest('hex') === expected.sha256;
}

export function validLierdaPublicAssets(directory, expected) {
  const path = join(directory, dirname(LIERDA_AGENTBOOT_PATH));
  const folder = lstatSync(path, { throwIfNoEntry: false });
  if (!folder) return expected === undefined;
  if (!folder.isDirectory()) return false;
  const entries = readdirSync(path);
  if (entries.length === 0) return expected === undefined;
  return entries.length === 1 && entries[0] === basename(LIERDA_AGENTBOOT_PATH) &&
    validLierdaAgentBoot(directory, expected);
}
