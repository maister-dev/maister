import "server-only";

import { randomInt } from "node:crypto";

import bcrypt from "bcryptjs";

const ROUNDS = 12;
const MIN_TEMP_PASSWORD_LENGTH = 12;

const LOWER = "abcdefghijkmnpqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SPECIAL = "!@#$%^&*-_=+";
const ALPHABET = LOWER + UPPER + DIGITS + SPECIAL;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

function pick(chars: string): string {
  return chars[randomInt(chars.length)];
}

function resolveLength(length: number): number {
  const requested = Math.floor(length);

  return Number.isFinite(requested)
    ? Math.max(MIN_TEMP_PASSWORD_LENGTH, requested)
    : MIN_TEMP_PASSWORD_LENGTH;
}

export function generateTempPassword(
  length: number = Number(process.env.MAISTER_TEMP_PASSWORD_LENGTH) ||
    MIN_TEMP_PASSWORD_LENGTH,
): string {
  const target = resolveLength(length);
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SPECIAL)];

  while (chars.length < target) chars.push(pick(ALPHABET));

  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);

    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join("");
}
