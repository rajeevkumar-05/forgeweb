import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ForgeUser } from "./domain.ts";
import { ApiError, id, now } from "./lib.ts";
import { JsonStore } from "./store.ts";

const COOKIE = "forgeweb_owner_session";
const TTL = 8 * 60 * 60 * 1000;
export type AuthenticatedUser = Pick<ForgeUser, "id" | "username" | "canClaimLocalProjects">;
const publicUser = (user: ForgeUser): AuthenticatedUser => ({ id: user.id, username: user.username, canClaimLocalProjects: user.canClaimLocalProjects });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function passwordHash(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}

function credentials(username: unknown, password: unknown): { username: string; password: string } {
  if (typeof username !== "string" || !/^[a-zA-Z0-9_.-]{3,64}$/.test(username)
    || typeof password !== "string" || password.length < 12 || password.length > 128) {
    throw new ApiError(400, "INVALID_CREDENTIALS", "Use a 3-64 character username and a password of 12-128 characters.");
  }
  return { username: username.toLowerCase(), password };
}

export class ForgeWebAuthentication {
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private readonly store: JsonStore;
  private readonly secure: boolean;
  constructor(store: JsonStore, secure = process.env.NODE_ENV === "production") { this.store = store; this.secure = secure; }

  // All browser mutations must originate from this application's origin. CLI
  // callers have no ambient cookies and may omit Origin, but not spoof Host.
  checkRequest(request: IncomingMessage): void {
    const host = request.headers.host ?? "";
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) throw new ApiError(403, "INVALID_HOST", "A trusted loopback host is required.");
    if (["GET", "HEAD"].includes(request.method ?? "GET")) return;
    const origin = request.headers.origin;
    const expected = `${this.secure ? "https" : "http"}://${host}`;
    if ((origin && origin !== expected) || request.headers["sec-fetch-site"] === "cross-site") {
      throw new ApiError(403, "CROSS_ORIGIN_REQUEST", "Cross-origin mutations are not allowed.");
    }
  }

  limit(request: IncomingMessage): void {
    const key = request.socket.remoteAddress ?? "unknown";
    const previous = this.attempts.get(key);
    const attempt = previous && previous.until > Date.now() ? previous : { count: 0, until: Date.now() + 60_000 };
    attempt.count++;
    this.attempts.set(key, attempt);
    if (this.attempts.size > 1000) for (const [address, entry] of this.attempts) if (entry.until <= Date.now()) this.attempts.delete(address);
    if (attempt.count > 10) throw new ApiError(429, "AUTH_RATE_LIMIT", "Too many login attempts. Try again in a minute.");
  }

  private sessionKey(request: IncomingMessage): string | undefined {
    const value = request.headers.cookie?.split(";").map(c => c.trim()).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    return value && /^[a-f0-9]{64}$/.test(value) ? hash(value) : undefined;
  }

  optionalUser(request: IncomingMessage): AuthenticatedUser | undefined {
    const key = this.sessionKey(request);
    const database = this.store.read();
    const session = key ? database.userSessions?.[key] : undefined;
    const user = session && session.expiresAt > Date.now() ? database.users?.[session.userId] : undefined;
    return user ? publicUser(user) : undefined;
  }

  requireUser(request: IncomingMessage): AuthenticatedUser {
    const user = this.optionalUser(request);
    if (!user) throw new ApiError(401, "LOGIN_REQUIRED", "Sign in to ForgeWeb to access your projects.");
    return user;
  }

  private cookie(value: string, age = TTL / 1000): string {
    return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${age}${this.secure ? "; Secure" : ""}`;
  }

  async login(usernameValue: unknown, passwordValue: unknown, register = false, previous?: IncomingMessage): Promise<{ user: AuthenticatedUser; cookie: string }> {
    const input = credentials(usernameValue, passwordValue);
    const existing = Object.values(this.store.read().users ?? {}).find(user => user.username === input.username);
    const salt = existing?.passwordSalt ?? randomBytes(32).toString("hex");
    const derived = await passwordHash(input.password, salt);
    if (!register && (!existing || !timingSafeEqual(derived, Buffer.from(existing.passwordHash, "hex")))) {
      throw new ApiError(401, "LOGIN_FAILED", "The username or password is incorrect.");
    }
    const token = randomBytes(32).toString("hex");
    const user = await this.store.mutate(database => {
      database.users ??= {};
      database.userSessions ??= {};
      let user = existing;
      if (register) {
        if (Object.values(database.users).some(u => u.username === input.username)) throw new ApiError(409, "ACCOUNT_EXISTS", "That username is already registered.");
        user = { id: id("user"), username: input.username, passwordHash: derived.toString("hex"), passwordSalt: salt,
          createdAt: now(), canClaimLocalProjects: Object.keys(database.users).length === 0 };
        database.users[user.id] = user;
      }
      if (!user) throw new ApiError(401, "LOGIN_FAILED", "The username or password is incorrect.");
      const oldKey = previous ? this.sessionKey(previous) : undefined;
      if (oldKey) delete database.userSessions[oldKey];
      for (const [key, session] of Object.entries(database.userSessions)) if (session.expiresAt <= Date.now()) delete database.userSessions[key];
      database.userSessions[hash(token)] = { userId: user.id, expiresAt: Date.now() + TTL };
      return publicUser(user);
    });
    return { user, cookie: this.cookie(token) };
  }

  async logout(request: IncomingMessage): Promise<string> {
    const key = this.sessionKey(request);
    if (key) await this.store.mutate(database => { if (database.userSessions) delete database.userSessions[key]; });
    return this.cookie("", 0);
  }
}
