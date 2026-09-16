import assert from "node:assert/strict";
import test from "node:test";
import { AdminAuthSource, AdminRole, PrismaClient } from "@prisma/client";
import {
  AdminAuthError,
  AdminAuthService,
  capabilitiesForRole,
  canAccessTenant,
  hashAdminPassword,
  hashBearerToken,
  requireAdminCapability,
  requireTenantAuthorization,
  signAdminSessionToken,
  verifyAdminPassword,
  verifyAdminSessionToken,
  type AdminPrincipal,
  type SessionTokenPayload,
} from "./admin-auth.js";

const secret = "integration-session-secret-with-more-than-32-bytes";

test("scrypt gera hashes salgados e verifica a senha sem armazenar texto puro", async () => {
  const first = await hashAdminPassword("uma senha realmente segura");
  const second = await hashAdminPassword("uma senha realmente segura");
  assert.notEqual(first, second);
  assert.match(first, /^scrypt\$v=1\$N=16384,r=8,p=1\$/);
  assert.equal(await verifyAdminPassword("uma senha realmente segura", first), true);
  assert.equal(await verifyAdminPassword("senha incorreta", first), false);
  assert.equal(await verifyAdminPassword("uma senha realmente segura", "formato-invalido"), false);
});

test("token bearer assinado detecta alteração e expiração", () => {
  const payload: SessionTokenPayload = {
    v: 1,
    sid: "session-1",
    sub: "user-1",
    iat: 2_000_000_000,
    exp: 2_000_003_600,
    nonce: "nonce-with-enough-entropy",
  };
  const token = signAdminSessionToken(payload, secret);
  assert.deepEqual(
    verifyAdminSessionToken(token, secret, new Date(payload.iat * 1_000)),
    payload,
  );
  assert.throws(
    () => verifyAdminSessionToken(`${token.slice(0, -1)}x`, secret, new Date(payload.iat * 1_000)),
    (error: unknown) => error instanceof AdminAuthError
      && error.code === "invalid_session_signature",
  );
  assert.throws(
    () => verifyAdminSessionToken(token, secret, new Date(payload.exp * 1_000)),
    (error: unknown) => error instanceof AdminAuthError
      && error.code === "session_expired",
  );
  assert.match(hashBearerToken(token), /^[a-f0-9]{64}$/);
});

test("capabilities separam administrador de plataforma e usuário de tenant", () => {
  const tenantPrincipal: AdminPrincipal = {
    userId: "user-1",
    sessionId: "session-1",
    email: "user@example.com",
    name: "Usuário",
    role: AdminRole.TENANT_USER,
    capabilities: capabilitiesForRole(AdminRole.TENANT_USER),
    tenantIds: ["tenant-a"],
    expiresAt: new Date(Date.now() + 60_000),
  };
  assert.equal(canAccessTenant(tenantPrincipal, "tenant-a"), true);
  assert.equal(canAccessTenant(tenantPrincipal, "tenant-b"), false);
  requireTenantAuthorization(tenantPrincipal, "tenant-a", "tenant:write");
  assert.throws(
    () => requireTenantAuthorization(tenantPrincipal, "tenant-b"),
    (error: unknown) => error instanceof AdminAuthError && error.code === "tenant_forbidden",
  );
  assert.throws(
    () => requireAdminCapability(tenantPrincipal, "providers:write"),
    (error: unknown) => error instanceof AdminAuthError && error.code === "forbidden",
  );

  const platformPrincipal = {
    ...tenantPrincipal,
    role: AdminRole.PLATFORM_ADMIN,
    capabilities: capabilitiesForRole(AdminRole.PLATFORM_ADMIN),
    tenantIds: [],
  };
  requireAdminCapability(platformPrincipal, "providers:write");
  requireTenantAuthorization(platformPrincipal, "qualquer-tenant", "tenant:write");

  const channelPrincipal = {
    ...tenantPrincipal,
    role: AdminRole.CHANNEL_MANAGER,
    capabilities: capabilitiesForRole(AdminRole.CHANNEL_MANAGER),
  };
  requireTenantAuthorization(channelPrincipal, "tenant-a", "channels:write");
  assert.throws(
    () => requireTenantAuthorization(channelPrincipal, "tenant-a", "tenant:read"),
    (error: unknown) => error instanceof AdminAuthError && error.code === "forbidden",
  );
  assert.throws(
    () => requireTenantAuthorization(channelPrincipal, "tenant-b", "channels:read"),
    (error: unknown) => error instanceof AdminAuthError && error.code === "tenant_forbidden",
  );
});

test("createUser normaliza e-mail, associa tenant ativo e não retorna passwordHash", async () => {
  let createdData: Record<string, unknown> | undefined;
  const now = new Date("2026-07-28T12:00:00Z");
  const fakePrisma = {
    tenant: {
      findMany: async () => [{ id: "tenant-a" }],
    },
    adminUser: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdData = data;
        return {
          id: "user-1",
          email: data.email as string,
          name: data.name as string,
          passwordHash: data.passwordHash as string,
          authSource: data.authSource as AdminAuthSource,
          externalSubject: null,
          role: data.role as AdminRole,
          active: true,
          passwordChangedAt: now,
          lastLoginAt: null,
          createdAt: now,
          updatedAt: now,
        };
      },
    },
  } as unknown as PrismaClient;
  const service = new AdminAuthService(fakePrisma, { sessionSecret: secret });
  const user = await service.createUser({
    email: "  ADMIN@EXAMPLE.COM ",
    name: "Administrador",
    password: "senha longa e segura",
    role: AdminRole.TENANT_USER,
    tenantIds: ["tenant-a"],
  });
  assert.equal(user.email, "admin@example.com");
  assert.equal(user.authSource, AdminAuthSource.LOCAL);
  assert.equal("passwordHash" in user, false);
  assert.match(String(createdData?.passwordHash), /^scrypt\$/);
  assert.deepEqual(createdData?.memberships, {
    create: [{ tenantId: "tenant-a" }],
  });
});

test("TENANT_USER sem associação ativa é rejeitado", async () => {
  const fakePrisma = {
    tenant: { findMany: async () => [] },
  } as unknown as PrismaClient;
  const service = new AdminAuthService(fakePrisma, { sessionSecret: secret });
  await assert.rejects(
    service.createUser({
      email: "user@example.com",
      name: "Usuário",
      password: "senha longa e segura",
      role: AdminRole.TENANT_USER,
      tenantIds: [],
    }),
    (error: unknown) => error instanceof AdminAuthError
      && error.code === "tenant_membership_required",
  );
});

test("sessão persistida vincula token assinado, usuário e memberships ativos", async () => {
  const now = new Date("2030-01-01T12:00:00Z");
  const user = {
    id: "user-1",
    email: "user@example.com",
    name: "Usuário",
    passwordHash: "unused",
    role: AdminRole.TENANT_USER,
    active: true,
    passwordChangedAt: new Date("2029-12-01T00:00:00Z"),
    lastLoginAt: null,
    createdAt: new Date("2029-12-01T00:00:00Z"),
    updatedAt: new Date("2029-12-01T00:00:00Z"),
    memberships: [{ tenantId: "tenant-a" }],
  };
  let storedSession: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    createdAt: Date;
    revokedAt: Date | null;
    lastUsedAt: Date | null;
    user: typeof user;
  } | undefined;
  const fakePrisma = {
    adminUser: {
      findUnique: async () => user,
      update: async () => user,
    },
    adminSession: {
      create: async ({ data }: { data: Omit<NonNullable<typeof storedSession>, "user" | "revokedAt" | "lastUsedAt"> }) => {
        storedSession = {
          ...data,
          revokedAt: null,
          lastUsedAt: null,
          user,
        };
        return storedSession;
      },
      findUnique: async () => storedSession,
      update: async ({ data }: { data: { lastUsedAt: Date } }) => {
        if (storedSession) storedSession.lastUsedAt = data.lastUsedAt;
        return storedSession;
      },
    },
    $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
  } as unknown as PrismaClient;
  const service = new AdminAuthService(fakePrisma, {
    sessionSecret: secret,
    now: () => now,
  });
  const issued = await service.issueSession(user.id);
  assert.match(issued.token, /^omni\.v1\./);
  assert.equal(storedSession?.tokenHash, hashBearerToken(issued.token));
  const principal = await service.authenticateBearer(issued.token);
  assert.equal(principal.userId, user.id);
  assert.deepEqual(principal.tenantIds, ["tenant-a"]);
  assert.equal(principal.role, AdminRole.TENANT_USER);
  assert.equal(storedSession?.lastUsedAt?.toISOString(), now.toISOString());
});
