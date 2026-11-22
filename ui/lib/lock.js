// The password that keeps a machine or hub PC in its mode. settings.json keeps only a salted PBKDF2 hash.
import { enc } from "./util.js";

const ITER = 200000;
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));

async function derive(password, salt, iter) {
  const key = await crypto.subtle.importKey("raw", enc(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unhex(salt), iterations: iter }, key, 256));
}

/** -> {salt, iter, hash} for settings.lock */
export async function makeLock(password, repeat) {
  if (password.length < 4) throw new Error("Use at least 4 characters.");
  if (password !== repeat) throw new Error("The two passwords are not the same.");
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, iter: ITER, hash: await derive(password, salt, ITER) };
}

export const checkLock = async (lock, password) => (await derive(password, lock.salt, lock.iter)) === lock.hash;
