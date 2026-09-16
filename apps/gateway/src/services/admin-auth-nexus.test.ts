import assert from "node:assert/strict";
import test from "node:test";
import { AdminAuthSource, AdminRole, Prisma, type PrismaClient } from "@prisma/client";
import {
  AdminAuthError,
  AdminAuthService,
  hashAdminPassword,
} from "./admin-auth.js";
import {
  NEXUS_SSO_AUDIENCE,
  NEXUS_SSO_ISSUER,
  type NexusSsoClaims,
} from "./nexus-sso.js";

const secret = "nexus-session-secret-with-more-than-32-bytes";
const now = new Date("2026-08-20T12:00:00.000Z");
const issuedAt = Math.floor(now.getTime() / 1_000);

function claims(overrides: Partial<NexusSsoClaims> = {}): NexusSsoClaims {
  return {
    version: 1,
    issuer: NEXUS_SSO_ISSUER,
    audience: NEXUS_SSO_AUDIENCE,
    subject: "nexus-subject-1",
    email: "nexus@example.com",
    name: "Usuário Nexus",
    role: AdminRole.PLATFORM_ADMIN,
    tenantSlugs: [],
    jti: "2ab1daac-a9e9-4b4d-9d42-13c797d5d20a",
    issuedAt,
    expiresAt: issuedAt + 60,
    ...overrides,
  };
}

type MemoryUser = {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  authSource: AdminAuthSource;
  externalSubject: string | null;
  role: AdminRole;
  active: boolean;
  passwordChangedAt: Date;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type MemorySession = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
};

function selected<T extends Record<string, unknown>>(value: T, select: Record<string, boolean> | undefined) {
  if (!select) return value;
  return Object.fromEntries(Object.keys(select).filter(key => select[key]).map(key => [key, value[key]]));
}

function memoryPrisma(input: {
  tenants?: Array<{ id: string; slug: string; active: boolean }>;
  users?: MemoryUser[];
  memberships?: Array<{ userId: string; tenantId: string }>;
  sessions?: MemorySession[];
} = {}) {
  const state = {
    tenants: input.tenants ?? [],
    users: input.users ?? [],
    memberships: input.memberships ?? [],
    sessions: input.sessions ?? [],
  };
  let nextUser = state.users.length + 1;
  const api: any = {};
  api.tenant = {
    findMany: async ({ where }: any) => state.tenants
      .filter(tenant => tenant.active && (
        where?.slug?.in ? where.slug.in.includes(tenant.slug)
          : where?.id?.in ? where.id.in.includes(tenant.id)
            : true
      ))
      .map(tenant => ({ id: tenant.id, slug: tenant.slug })),
  };
  api.adminUser = {
    findUnique: async ({ where, select, include }: any) => {
      const user = state.users.find(candidate => (
        where.id ? candidate.id === where.id
          : where.email ? candidate.email === where.email
            : where.authSource_externalSubject
              ? candidate.authSource === where.authSource_externalSubject.authSource
                && candidate.externalSubject === where.authSource_externalSubject.externalSubject
              : false
      ));
      if (!user) return null;
      if (include?.memberships) {
        return {
          ...user,
          memberships: state.memberships
            .filter(item => item.userId === user.id)
            .filter(item => state.tenants.some(tenant => tenant.id === item.tenantId && tenant.active))
            .map(item => ({ tenantId: item.tenantId })),
        };
      }
      return selected(user as unknown as Record<string, unknown>, select);
    },
    create: async ({ data, select }: any) => {
      if (state.users.some(user => user.email === data.email
        || (user.authSource === data.authSource && user.externalSubject === data.externalSubject))) {
        throw new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "test",
        });
      }
      const user: MemoryUser = {
        id: `user-${nextUser++}`,
        email: data.email,
        name: data.name,
        passwordHash: data.passwordHash,
        authSource: data.authSource ?? AdminAuthSource.LOCAL,
        externalSubject: data.externalSubject ?? null,
        role: data.role,
        active: true,
        passwordChangedAt: now,
        lastLoginAt: null,
        createdAt: now,
        updatedAt: now,
      };
      state.users.push(user);
      return selected(user as unknown as Record<string, unknown>, select);
    },
    update: async ({ where, data, select }: any) => {
      const user = state.users.find(candidate => candidate.id === where.id);
      if (!user) throw new Error("missing_user");
      Object.assign(user, data, { updatedAt: now });
      return selected(user as unknown as Record<string, unknown>, select);
    },
  };
  api.adminUserTenant = {
    deleteMany: async ({ where }: any) => {
      const before = state.memberships.length;
      state.memberships = state.memberships.filter(item => item.userId !== where.userId);
      return { count: before - state.memberships.length };
    },
    createMany: async ({ data }: any) => {
      state.memberships.push(...data);
      return { count: data.length };
    },
  };
  api.adminSession = {
    create: async ({ data }: any) => {
      if (state.sessions.some(session => session.id === data.id || session.tokenHash === data.tokenHash)) {
        throw new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "test",
        });
      }
      const session: MemorySession = { ...data, revokedAt: null, lastUsedAt: null };
      state.sessions.push(session);
      return session;
    },
    findUnique: async ({ where }: any) => {
      const session = state.sessions.find(candidate => candidate.id === where.id);
      if (!session) return null;
      const user = state.users.find(candidate => candidate.id === session.userId)!;
      return {
        ...session,
        user: {
          ...user,
          memberships: state.memberships
            .filter(item => item.userId === user.id)
            .filter(item => state.tenants.some(tenant => tenant.id === item.tenantId && tenant.active))
            .map(item => ({ tenantId: item.tenantId })),
        },
      };
    },
    update: async ({ where, data }: any) => {
      const session = state.sessions.find(candidate => candidate.id === where.id)!;
      Object.assign(session, data);
      return session;
    },
    updateMany: async ({ where, data }: any) => {
      const matches = state.sessions.filter(session => (
        (!where.userId || session.userId === where.userId)
        && (where.revokedAt !== null || session.revokedAt === null)
      ));
      matches.forEach(session => Object.assign(session, data));
      return { count: matches.length };
    },
  };
  api.$transaction = async (operations: unknown) => typeof operations === "function"
    ? operations(api)
    : Promise.all(operations as Promise<unknown>[]);
  return { prisma: api as PrismaClient, state };
}

function authError(code: string) {
  return (error: unknown) => error instanceof AdminAuthError && error.code === code;
}

test("SSO provisiona PLATFORM_ADMIN e a sessão comum permanece autenticável por uma hora", async () => {
  const { prisma, state } = memoryPrisma();
  const service = new AdminAuthService(prisma, { sessionSecret: secret, now: () => now });
  const result = await service.authenticateWithNexus(claims());

  assert.equal(result.principal.role, AdminRole.PLATFORM_ADMIN);
  assert.equal(result.principal.sessionId, claims().jti);
  assert.equal(result.expiresAt.getTime() - now.getTime(), 60 * 60 * 1_000);
  assert.equal(state.users[0]?.authSource, AdminAuthSource.NEXUS);
  assert.equal(state.users[0]?.externalSubject, claims().subject);
  assert.match(state.users[0]?.passwordHash ?? "", /^scrypt\$/u);

  const later = await service.authenticateBearer(result.token, { touch: false });
  assert.equal(later.userId, result.principal.userId);
  assert.equal(later.sessionId, claims().jti);
});

test("SSO TENANT_USER resolve somente slugs ativos e atualiza dados e memberships", async () => {
  const { prisma, state } = memoryPrisma({
    tenants: [
      { id: "tenant-a", slug: "company-alpha", active: true },
      { id: "tenant-b", slug: "company-beta", active: true },
    ],
  });
  const service = new AdminAuthService(prisma, { sessionSecret: secret, now: () => now });
  const firstClaims = claims({
    role: AdminRole.TENANT_USER,
    tenantSlugs: ["company-alpha"],
  });
  await service.authenticateWithNexus(firstClaims);
  const second = await service.authenticateWithNexus({
    ...firstClaims,
    email: "novo@example.com",
    name: "Nome atualizado",
    tenantSlugs: ["company-beta"],
    jti: "c61059d1-51ca-47c9-9d22-fce9bf427831",
  });

  assert.deepEqual(second.principal.tenantIds, ["tenant-b"]);
  assert.equal(state.users.length, 1);
  assert.equal(state.users[0]?.email, "novo@example.com");
  assert.equal(state.users[0]?.name, "Nome atualizado");
  assert.deepEqual(state.memberships, [{ userId: state.users[0]!.id, tenantId: "tenant-b" }]);
});

test("SSO CHANNEL_MANAGER recebe somente capacidades de canais nos tenants emitidos", async () => {
  const { prisma } = memoryPrisma({
    tenants: [
      { id: "tenant-a", slug: "company-alpha", active: true },
      { id: "tenant-b", slug: "company-beta", active: true },
    ],
  });
  const service = new AdminAuthService(prisma, { sessionSecret: secret, now: () => now });
  const result = await service.authenticateWithNexus(claims({
    role: AdminRole.CHANNEL_MANAGER,
    tenantSlugs: ["company-alpha", "company-beta"],
  }));
  assert.deepEqual(result.principal.tenantIds, ["tenant-a", "tenant-b"]);
  assert.deepEqual(result.principal.capabilities, ["channels:read", "channels:write"]);
});

test("SSO TENANT_USER rejeita tenant inexistente ou ausência de tenant", async () => {
  const { prisma } = memoryPrisma({
    tenants: [{ id: "tenant-a", slug: "company-alpha", active: true }],
  });
  const service = new AdminAuthService(prisma, { sessionSecret: secret, now: () => now });
  await assert.rejects(
    service.authenticateWithNexus(claims({ role: AdminRole.TENANT_USER, tenantSlugs: [] })),
    authError("sso_tenant_required"),
  );
  await assert.rejects(
    service.authenticateWithNexus(claims({ role: AdminRole.TENANT_USER, tenantSlugs: ["inexistente"] })),
    authError("sso_tenant_invalid"),
  );
});

test("SSO não toma e-mail LOCAL de tenant ou com papel incompatível", async () => {
  const passwordHash = await hashAdminPassword("senha local realmente segura");
  const local: MemoryUser = {
    id: "local-1",
    email: "nexus@example.com",
    name: "Usuário local",
    passwordHash,
    authSource: AdminAuthSource.LOCAL,
    externalSubject: null,
    role: AdminRole.TENANT_USER,
    active: true,
    passwordChangedAt: now,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const { prisma } = memoryPrisma({ users: [local] });
  const service = new AdminAuthService(prisma, { sessionSecret: secret, now: () => now });
  await assert.rejects(service.authenticateWithNexus(claims()), authError("external_email_conflict"));
});

test("primeiro SSO PLATFORM_ADMIN vincula o administrador LOCAL compatível e revoga sessões antigas", async () => {
  const passwordHash = await hashAdminPassword("senha local realmente segura");
  const local: MemoryUser = {
    id: "local-admin",
    email: "nexus@example.com",
    name: "Administrador local",
    passwordHash,
    authSource: AdminAuthSource.LOCAL,
    externalSubject: null,
    role: AdminRole.PLATFORM_ADMIN,
    active: true,
    passwordChangedAt: new Date(now.getTime() - 60_000),
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const oldSession: MemorySession = {
    id: "old-session",
    userId: local.id,
    tokenHash: "old-hash",
    expiresAt: new Date(now.getTime() + 60_000),
    createdAt: new Date(now.getTime() - 30_000),
    revokedAt: null,
    lastUsedAt: null,
  };
  const { prisma, state } = memoryPrisma({ users: [local], sessions: [oldSession] });
  const service = new AdminAuthService(prisma, { sessionSecret: secret, now: () => now });
  const result = await service.authenticateWithNexus(claims());

  assert.equal(result.principal.userId, local.id);
  assert.equal(state.users.length, 1);
  assert.equal(local.authSource, AdminAuthSource.NEXUS);
  assert.equal(local.externalSubject, claims().subject);
  assert.equal(oldSession.revokedAt?.toISOString(), now.toISOString());
  await assert.rejects(
    service.authenticateWithPassword({ email: local.email, password: "senha local realmente segura" }),
    authError("invalid_credentials"),
  );
  await assert.rejects(
    service.setPassword(local.id, "uma nova senha realmente segura"),
    authError("identity_managed_by_nexus"),
  );
  await assert.rejects(
    service.replaceTenantMemberships(local.id, []),
    authError("identity_managed_by_nexus"),
  );
  await assert.rejects(
    service.setUserActive(local.id, false),
    authError("identity_managed_by_nexus"),
  );
});

test("jti persistido impede reutilização do mesmo ticket Nexus", async () => {
  const { prisma } = memoryPrisma();
  const service = new AdminAuthService(prisma, { sessionSecret: secret, now: () => now });
  const ticket = claims();
  await service.authenticateWithNexus(ticket);
  await assert.rejects(service.authenticateWithNexus(ticket), authError("sso_ticket_used"));
});
