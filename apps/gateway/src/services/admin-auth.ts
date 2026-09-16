import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { AdminAuthSource, AdminRole, Prisma, PrismaClient } from "@prisma/client";
import type { NexusSsoClaims } from "./nexus-sso.js";

const PASSWORD_KEY_LENGTH = 64;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1_024;
const DEFAULT_SESSION_SECONDS = 8 * 60 * 60;
const MIN_SESSION_SECONDS = 5 * 60;
const MAX_SESSION_SECONDS = 30 * 24 * 60 * 60;
const SESSION_TOKEN_PREFIX = "omni.v1";

export const adminCapabilities = [
  "admin:global",
  "tenants:write",
  "users:write",
  "providers:write",
  "tenant:read",
  "tenant:write",
  "channels:read",
  "channels:write",
] as const;

export type AdminCapability = typeof adminCapabilities[number];

const roleCapabilities: Record<AdminRole, readonly AdminCapability[]> = {
  [AdminRole.PLATFORM_ADMIN]: adminCapabilities,
  [AdminRole.TENANT_USER]: ["tenant:read", "tenant:write", "channels:read", "channels:write"],
  [AdminRole.CHANNEL_MANAGER]: ["channels:read", "channels:write"],
};

export type AdminPrincipal = {
  userId: string;
  sessionId: string;
  email: string;
  name: string;
  role: AdminRole;
  capabilities: readonly AdminCapability[];
  tenantIds: readonly string[];
  expiresAt: Date;
};

export type SessionTokenPayload = {
  v: 1;
  sid: string;
  sub: string;
  iat: number;
  exp: number;
  nonce: string;
};

export class AdminAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "AdminAuthError";
  }
}

function normalizeUnicode(value: string): string {
  return value.normalize("NFKC").trim();
}

export function normalizeAdminEmail(value: string): string {
  const email = normalizeUnicode(value).toLowerCase();
  if (
    email.length < 3
    || email.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
  ) {
    throw new AdminAuthError("invalid_email", "E-mail administrativo inválido.", 400);
  }
  return email;
}

function validateDisplayName(value: string): string {
  const name = normalizeUnicode(value);
  if (!name || name.length > 160) {
    throw new AdminAuthError("invalid_name", "Nome deve possuir entre 1 e 160 caracteres.", 400);
  }
  return name;
}

function validatePassword(password: string) {
  if (
    typeof password !== "string"
    || password.length < MIN_PASSWORD_LENGTH
    || password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new AdminAuthError(
      "invalid_password",
      `A senha deve possuir entre ${MIN_PASSWORD_LENGTH} e ${MAX_PASSWORD_LENGTH} caracteres.`,
      400,
    );
  }
}

function deriveScryptKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, {
      ...options,
      maxmem: SCRYPT_MAX_MEMORY,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey as Buffer);
    });
  });
}

export async function hashAdminPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16);
  const derivedKey = await deriveScryptKey(password, salt, PASSWORD_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    "scrypt",
    "v=1",
    `N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}`,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

function parseScryptParameters(value: string) {
  const match = /^N=(\d+),r=(\d+),p=(\d+)$/u.exec(value);
  if (!match) return null;
  const N = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  if (
    !Number.isInteger(N)
    || N < 2 ** 12
    || N > 2 ** 18
    || (N & (N - 1)) !== 0
    || !Number.isInteger(r)
    || r < 1
    || r > 16
    || !Number.isInteger(p)
    || p < 1
    || p > 4
  ) return null;
  return { N, r, p };
}

export async function verifyAdminPassword(password: string, encodedHash: string): Promise<boolean> {
  if (
    typeof password !== "string"
    || password.length > MAX_PASSWORD_LENGTH
    || typeof encodedHash !== "string"
  ) return false;
  const parts = encodedHash.split("$");
  if (parts.length !== 5 || parts[0] !== "scrypt" || parts[1] !== "v=1") return false;
  const parameters = parseScryptParameters(parts[2]!);
  if (!parameters) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[3]!, "base64url");
    expected = Buffer.from(parts[4]!, "base64url");
  } catch {
    return false;
  }
  if (salt.length < 16 || expected.length !== PASSWORD_KEY_LENGTH) return false;
  try {
    const actual = await deriveScryptKey(password, salt, expected.length, parameters);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

async function consumePasswordWork(password: string) {
  const bounded = typeof password === "string" ? password.slice(0, MAX_PASSWORD_LENGTH) : "";
  await deriveScryptKey(bounded, Buffer.alloc(16, 0x5a), PASSWORD_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
}

function secretBuffer(secret: string | Buffer): Buffer {
  const value = Buffer.isBuffer(secret) ? secret : Buffer.from(secret, "utf8");
  if (value.length < 32) {
    throw new AdminAuthError(
      "weak_session_secret",
      "O segredo de sessão deve possuir pelo menos 32 bytes.",
      500,
    );
  }
  return value;
}

function tokenSignature(payload: string, secret: Buffer): Buffer {
  return createHmac("sha256", secret).update(`${SESSION_TOKEN_PREFIX}.${payload}`, "utf8").digest();
}

export function signAdminSessionToken(
  payload: SessionTokenPayload,
  sessionSecret: string | Buffer,
): string {
  const secret = secretBuffer(sessionSecret);
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = tokenSignature(encodedPayload, secret).toString("base64url");
  return `${SESSION_TOKEN_PREFIX}.${encodedPayload}.${signature}`;
}

export function verifyAdminSessionToken(
  token: string,
  sessionSecret: string | Buffer,
  now = new Date(),
): SessionTokenPayload {
  if (typeof token !== "string" || token.length > 4_096) {
    throw new AdminAuthError("invalid_session", "Sessão inválida.", 401);
  }
  const parts = token.split(".");
  if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== SESSION_TOKEN_PREFIX) {
    throw new AdminAuthError("invalid_session", "Sessão inválida.", 401);
  }
  const encodedPayload = parts[2]!;
  let receivedSignature: Buffer;
  try {
    receivedSignature = Buffer.from(parts[3]!, "base64url");
  } catch {
    throw new AdminAuthError("invalid_session", "Sessão inválida.", 401);
  }
  const expectedSignature = tokenSignature(encodedPayload, secretBuffer(sessionSecret));
  if (
    receivedSignature.length !== expectedSignature.length
    || !timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    throw new AdminAuthError("invalid_session_signature", "Assinatura da sessão inválida.", 401);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new AdminAuthError("invalid_session", "Sessão inválida.", 401);
  }
  const payload = parsed as Partial<SessionTokenPayload>;
  if (
    payload.v !== 1
    || typeof payload.sid !== "string"
    || !payload.sid
    || typeof payload.sub !== "string"
    || !payload.sub
    || !Number.isSafeInteger(payload.iat)
    || !Number.isSafeInteger(payload.exp)
    || typeof payload.nonce !== "string"
    || payload.nonce.length < 16
    || payload.exp! <= payload.iat!
  ) {
    throw new AdminAuthError("invalid_session", "Sessão inválida.", 401);
  }
  if (payload.exp! <= Math.floor(now.getTime() / 1_000)) {
    throw new AdminAuthError("session_expired", "Sessão expirada.", 401);
  }
  return payload as SessionTokenPayload;
}

export function hashBearerToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function capabilitiesForRole(role: AdminRole): readonly AdminCapability[] {
  return roleCapabilities[role];
}

export function hasAdminCapability(
  principal: AdminPrincipal,
  capability: AdminCapability,
): boolean {
  return principal.capabilities.includes(capability);
}

export function canAccessTenant(principal: AdminPrincipal, tenantId: string): boolean {
  return principal.role === AdminRole.PLATFORM_ADMIN || principal.tenantIds.includes(tenantId);
}

export function requireAdminCapability(
  principal: AdminPrincipal,
  capability: AdminCapability,
) {
  if (!hasAdminCapability(principal, capability)) {
    throw new AdminAuthError("forbidden", `Permissão necessária: ${capability}.`, 403);
  }
}

export function requireTenantAuthorization(
  principal: AdminPrincipal,
  tenantId: string,
  capability: AdminCapability = "tenant:read",
) {
  requireAdminCapability(principal, capability);
  if (!canAccessTenant(principal, tenantId)) {
    throw new AdminAuthError("tenant_forbidden", "Usuário não possui acesso ao tenant.", 403);
  }
}

function safeUser<T extends {
  id: string;
  email: string;
  name: string;
  authSource: AdminAuthSource;
  role: AdminRole;
  active: boolean;
  passwordChangedAt: Date;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>(user: T) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    authSource: user.authSource,
    role: user.role,
    active: user.active,
    passwordChangedAt: user.passwordChangedAt,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

type AdminAuthOptions = {
  sessionSecret: string | Buffer;
  defaultSessionSeconds?: number;
  maximumSessionSeconds?: number;
  now?: () => Date;
};

export class AdminAuthService {
  private readonly sessionSecret: Buffer;
  private readonly defaultSessionSeconds: number;
  private readonly maximumSessionSeconds: number;
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    options: AdminAuthOptions,
  ) {
    this.sessionSecret = secretBuffer(options.sessionSecret);
    this.maximumSessionSeconds = options.maximumSessionSeconds ?? MAX_SESSION_SECONDS;
    this.defaultSessionSeconds = options.defaultSessionSeconds ?? DEFAULT_SESSION_SECONDS;
    if (
      !Number.isInteger(this.maximumSessionSeconds)
      || this.maximumSessionSeconds < MIN_SESSION_SECONDS
      || this.maximumSessionSeconds > MAX_SESSION_SECONDS
      || !Number.isInteger(this.defaultSessionSeconds)
      || this.defaultSessionSeconds < MIN_SESSION_SECONDS
      || this.defaultSessionSeconds > this.maximumSessionSeconds
    ) {
      throw new AdminAuthError("invalid_session_ttl", "Configuração de duração da sessão inválida.", 500);
    }
    this.now = options.now ?? (() => new Date());
  }

  private async requireActiveTenantIds(tenantIds: readonly string[]) {
    const uniqueIds = [...new Set(tenantIds.map(value => value.trim()).filter(Boolean))];
    if (!uniqueIds.length) return [];
    const tenants = await this.prisma.tenant.findMany({
      where: { id: { in: uniqueIds }, active: true },
      select: { id: true },
    });
    if (tenants.length !== uniqueIds.length) {
      throw new AdminAuthError(
        "invalid_tenant_membership",
        "Um ou mais tenants não existem ou estão inativos.",
        400,
      );
    }
    return uniqueIds;
  }

  async createUser(input: {
    email: string;
    name: string;
    password: string;
    role: AdminRole;
    tenantIds?: readonly string[];
  }) {
    const email = normalizeAdminEmail(input.email);
    const name = validateDisplayName(input.name);
    validatePassword(input.password);
    const tenantIds = await this.requireActiveTenantIds(input.tenantIds ?? []);
    if (input.role !== AdminRole.PLATFORM_ADMIN && !tenantIds.length) {
      throw new AdminAuthError(
        "tenant_membership_required",
        "Usuários de tenant precisam de ao menos um tenant ativo.",
        400,
      );
    }
    const passwordHash = await hashAdminPassword(input.password);
    const user = await this.prisma.adminUser.create({
      data: {
        email,
        name,
        passwordHash,
        authSource: AdminAuthSource.LOCAL,
        role: input.role,
        memberships: tenantIds.length
          ? { create: tenantIds.map(tenantId => ({ tenantId })) }
          : undefined,
      },
    });
    return safeUser(user);
  }

  async replaceTenantMemberships(userId: string, tenantIds: readonly string[]) {
    const user = await this.prisma.adminUser.findUnique({
      where: { id: userId },
      select: { id: true, role: true, active: true, authSource: true },
    });
    if (!user) throw new AdminAuthError("user_not_found", "Usuário não encontrado.", 404);
    if (user.authSource === AdminAuthSource.NEXUS) {
      throw new AdminAuthError(
        "identity_managed_by_nexus",
        "Esta identidade é gerenciada pelo Nexus.",
        409,
      );
    }
    const normalizedIds = await this.requireActiveTenantIds(tenantIds);
    if (user.role !== AdminRole.PLATFORM_ADMIN && !normalizedIds.length) {
      throw new AdminAuthError(
        "tenant_membership_required",
        "Usuários de tenant precisam de ao menos um tenant ativo.",
        400,
      );
    }
    await this.prisma.$transaction([
      this.prisma.adminUserTenant.deleteMany({ where: { userId } }),
      ...(normalizedIds.length
        ? [this.prisma.adminUserTenant.createMany({
          data: normalizedIds.map(tenantId => ({ userId, tenantId })),
        })]
        : []),
    ]);
    return normalizedIds;
  }

  async setPassword(userId: string, password: string) {
    const existing = await this.prisma.adminUser.findUnique({
      where: { id: userId },
      select: { authSource: true },
    });
    if (!existing) throw new AdminAuthError("user_not_found", "Usuário não encontrado.", 404);
    if (existing.authSource === AdminAuthSource.NEXUS) {
      throw new AdminAuthError(
        "identity_managed_by_nexus",
        "Esta identidade é gerenciada pelo Nexus.",
        409,
      );
    }
    validatePassword(password);
    const passwordHash = await hashAdminPassword(password);
    const now = this.now();
    try {
      const [user] = await this.prisma.$transaction([
        this.prisma.adminUser.update({
          where: { id: userId },
          data: { passwordHash, passwordChangedAt: now },
        }),
        this.prisma.adminSession.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: now },
        }),
      ]);
      return safeUser(user);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        throw new AdminAuthError("user_not_found", "Usuário não encontrado.", 404);
      }
      throw error;
    }
  }

  private sessionSeconds(requested?: number) {
    const seconds = requested ?? this.defaultSessionSeconds;
    if (
      !Number.isInteger(seconds)
      || seconds < MIN_SESSION_SECONDS
      || seconds > this.maximumSessionSeconds
    ) {
      throw new AdminAuthError(
        "invalid_session_ttl",
        `A sessão deve durar entre ${MIN_SESSION_SECONDS} e ${this.maximumSessionSeconds} segundos.`,
        400,
      );
    }
    return seconds;
  }

  async issueSession(userId: string, requestedSeconds?: number, sessionId?: string) {
    const user = await this.prisma.adminUser.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          where: { tenant: { active: true } },
          select: { tenantId: true },
        },
      },
    });
    if (!user || !user.active) {
      throw new AdminAuthError("invalid_credentials", "Credenciais inválidas.", 401);
    }
    const tenantIds = user.memberships.map(item => item.tenantId);
    if (user.role !== AdminRole.PLATFORM_ADMIN && !tenantIds.length) {
      throw new AdminAuthError("user_without_active_tenant", "Usuário não possui tenant ativo.", 403);
    }
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + this.sessionSeconds(requestedSeconds) * 1_000);
    const payload: SessionTokenPayload = {
      v: 1,
      sid: sessionId ?? randomUUID(),
      sub: user.id,
      iat: Math.floor(issuedAt.getTime() / 1_000),
      exp: Math.floor(expiresAt.getTime() / 1_000),
      nonce: randomBytes(18).toString("base64url"),
    };
    const token = signAdminSessionToken(payload, this.sessionSecret);
    await this.prisma.$transaction([
      this.prisma.adminSession.create({
        data: {
          id: payload.sid,
          userId: user.id,
          tokenHash: hashBearerToken(token),
          expiresAt,
          createdAt: issuedAt,
        },
      }),
      this.prisma.adminUser.update({
        where: { id: user.id },
        data: { lastLoginAt: issuedAt },
      }),
    ]);
    return {
      token,
      tokenType: "Bearer" as const,
      expiresAt,
      principal: {
        userId: user.id,
        sessionId: payload.sid,
        email: user.email,
        name: user.name,
        role: user.role,
        capabilities: capabilitiesForRole(user.role),
        tenantIds,
        expiresAt,
      } satisfies AdminPrincipal,
    };
  }

  async authenticateWithPassword(input: {
    email: string;
    password: string;
    sessionSeconds?: number;
  }) {
    let email: string;
    try {
      email = normalizeAdminEmail(input.email);
    } catch {
      await consumePasswordWork(input.password);
      throw new AdminAuthError("invalid_credentials", "Credenciais inválidas.", 401);
    }
    const user = await this.prisma.adminUser.findUnique({
      where: { email },
      select: { id: true, active: true, passwordHash: true, authSource: true },
    });
    if (!user) {
      await consumePasswordWork(input.password);
      throw new AdminAuthError("invalid_credentials", "Credenciais inválidas.", 401);
    }
    const valid = await verifyAdminPassword(input.password, user.passwordHash);
    if (!valid || !user.active || user.authSource !== AdminAuthSource.LOCAL) {
      throw new AdminAuthError("invalid_credentials", "Credenciais inválidas.", 401);
    }
    return this.issueSession(user.id, input.sessionSeconds);
  }

  async authenticateWithNexus(claims: NexusSsoClaims) {
    const email = normalizeAdminEmail(claims.email);
    const name = validateDisplayName(claims.name);
    const tenantSlugs = [...new Set(claims.tenantSlugs.map(slug => slug.trim()))];
    if (claims.role !== AdminRole.PLATFORM_ADMIN && !tenantSlugs.length) {
      throw new AdminAuthError(
        "sso_tenant_required",
        "O acesso de tenant emitido pelo Nexus não possui empresas associadas.",
        403,
      );
    }
    const tenants = tenantSlugs.length
      ? await this.prisma.tenant.findMany({
        where: { slug: { in: tenantSlugs }, active: true },
        select: { id: true, slug: true },
      })
      : [];
    const tenantBySlug = new Map(tenants.map(tenant => [tenant.slug, tenant.id]));
    if (tenantBySlug.size !== tenantSlugs.length) {
      throw new AdminAuthError(
        "sso_tenant_invalid",
        "Uma ou mais empresas emitidas pelo Nexus não existem ou estão inativas.",
        403,
      );
    }
    const tenantIds = tenantSlugs.map(slug => tenantBySlug.get(slug)!);
    const unusablePasswordHash = await hashAdminPassword(randomBytes(48).toString("base64url"));

    let userId: string;
    try {
      userId = await this.prisma.$transaction(async transaction => {
        const identity = await transaction.adminUser.findUnique({
          where: {
            authSource_externalSubject: {
              authSource: AdminAuthSource.NEXUS,
              externalSubject: claims.subject,
            },
          },
          select: { id: true, active: true },
        });
        const emailOwner = await transaction.adminUser.findUnique({
          where: { email },
          select: { id: true, authSource: true, role: true, active: true },
        });
        const canLinkLocalPlatform = !identity
          && emailOwner?.authSource === AdminAuthSource.LOCAL
          && emailOwner.role === AdminRole.PLATFORM_ADMIN
          && claims.role === AdminRole.PLATFORM_ADMIN;
        if (emailOwner && (!identity || emailOwner.id !== identity.id) && !canLinkLocalPlatform) {
          throw new AdminAuthError(
            "external_email_conflict",
            "Este e-mail já pertence a outra identidade administrativa.",
            409,
          );
        }
        if ((identity && !identity.active) || (canLinkLocalPlatform && !emailOwner.active)) {
          throw new AdminAuthError("sso_user_inactive", "Este acesso administrativo está desativado.", 403);
        }

        const user = identity
          ? await transaction.adminUser.update({
            where: { id: identity.id },
            data: { email, name, role: claims.role },
            select: { id: true },
          })
          : canLinkLocalPlatform
            ? await transaction.adminUser.update({
              where: { id: emailOwner.id },
              data: {
                name,
                role: claims.role,
                authSource: AdminAuthSource.NEXUS,
                externalSubject: claims.subject,
              },
              select: { id: true },
            })
            : await transaction.adminUser.create({
            data: {
              email,
              name,
              passwordHash: unusablePasswordHash,
              authSource: AdminAuthSource.NEXUS,
              externalSubject: claims.subject,
              role: claims.role,
            },
            select: { id: true },
          });

        if (canLinkLocalPlatform) {
          await transaction.adminSession.updateMany({
            where: { userId: user.id, revokedAt: null },
            data: { revokedAt: this.now() },
          });
        }

        await transaction.adminUserTenant.deleteMany({ where: { userId: user.id } });
        if (tenantIds.length) {
          await transaction.adminUserTenant.createMany({
            data: tenantIds.map(tenantId => ({ userId: user.id, tenantId })),
          });
        }
        return user.id;
      });
    } catch (error) {
      if (error instanceof AdminAuthError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AdminAuthError(
          "external_email_conflict",
          "Este e-mail já pertence a outra identidade administrativa.",
          409,
        );
      }
      throw error;
    }

    try {
      return await this.issueSession(userId, 60 * 60, claims.jti);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AdminAuthError("sso_ticket_used", "Este acesso do Nexus já foi utilizado.", 401);
      }
      throw error;
    }
  }

  async authenticateBearer(token: string, options: { touch?: boolean } = {}): Promise<AdminPrincipal> {
    const now = this.now();
    const payload = verifyAdminSessionToken(token, this.sessionSecret, now);
    const session = await this.prisma.adminSession.findUnique({
      where: { id: payload.sid },
      include: {
        user: {
          include: {
            memberships: {
              where: { tenant: { active: true } },
              select: { tenantId: true },
            },
          },
        },
      },
    });
    if (
      !session
      || session.userId !== payload.sub
      || session.revokedAt
      || session.expiresAt.getTime() <= now.getTime()
      || session.user.passwordChangedAt.getTime() > session.createdAt.getTime()
      || !session.user.active
    ) {
      throw new AdminAuthError("invalid_session", "Sessão inválida ou revogada.", 401);
    }
    const expectedHash = Buffer.from(session.tokenHash, "hex");
    const receivedHash = Buffer.from(hashBearerToken(token), "hex");
    if (
      expectedHash.length !== receivedHash.length
      || !timingSafeEqual(expectedHash, receivedHash)
    ) {
      throw new AdminAuthError("invalid_session", "Sessão inválida ou revogada.", 401);
    }
    const tenantIds = session.user.memberships.map(item => item.tenantId);
    if (session.user.role !== AdminRole.PLATFORM_ADMIN && !tenantIds.length) {
      throw new AdminAuthError("user_without_active_tenant", "Usuário não possui tenant ativo.", 403);
    }
    if (
      options.touch !== false
      && (!session.lastUsedAt || now.getTime() - session.lastUsedAt.getTime() >= 5 * 60 * 1_000)
    ) {
      await this.prisma.adminSession.update({
        where: { id: session.id },
        data: { lastUsedAt: now },
      });
    }
    return {
      userId: session.user.id,
      sessionId: session.id,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role,
      capabilities: capabilitiesForRole(session.user.role),
      tenantIds,
      expiresAt: session.expiresAt,
    };
  }

  async requireActiveTenantAccess(
    principal: AdminPrincipal,
    tenantId: string,
    capability: AdminCapability = "tenant:read",
  ) {
    requireTenantAuthorization(principal, tenantId, capability);
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, active: true },
      select: { id: true, slug: true, name: true, active: true },
    });
    if (!tenant) throw new AdminAuthError("tenant_not_found", "Tenant ativo não encontrado.", 404);
    return tenant;
  }

  async revokeBearer(token: string) {
    const result = await this.prisma.adminSession.updateMany({
      where: { tokenHash: hashBearerToken(token), revokedAt: null },
      data: { revokedAt: this.now() },
    });
    return result.count > 0;
  }

  async revokeAllSessions(userId: string) {
    return this.prisma.adminSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: this.now() },
    });
  }

  async setUserActive(userId: string, active: boolean) {
    const existing = await this.prisma.adminUser.findUnique({
      where: { id: userId },
      select: { authSource: true },
    });
    if (!existing) throw new AdminAuthError("user_not_found", "Usuário não encontrado.", 404);
    if (existing.authSource === AdminAuthSource.NEXUS) {
      throw new AdminAuthError(
        "identity_managed_by_nexus",
        "Esta identidade é gerenciada pelo Nexus.",
        409,
      );
    }
    const now = this.now();
    try {
      const [user] = await this.prisma.$transaction([
        this.prisma.adminUser.update({
          where: { id: userId },
          data: { active },
        }),
        ...(!active ? [this.prisma.adminSession.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: now },
        })] : []),
      ]);
      return safeUser(user);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        throw new AdminAuthError("user_not_found", "Usuário não encontrado.", 404);
      }
      throw error;
    }
  }
}
