import { basename } from "node:path";
import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";
import { importFile } from "/app/apps/gateway/dist/services/importer.js";

const [tenantSlug, filePath, role] = process.argv.slice(2);
if (!tenantSlug || !filePath || !role) throw new Error("tenant, file and role are required");
const prisma = new PrismaClient();
try {
  const tenant = await prisma.tenant.findFirst({ where: { slug: tenantSlug }, select: { id: true } });
  if (!tenant) throw new Error(`tenant not found: ${tenantSlug}`);
  const documents = await importFile(prisma, tenant.id, filePath, basename(filePath), {}, { agentRole: role });
  console.log(JSON.stringify({ tenant: tenantSlug, role, chunks: documents.length }));
} finally {
  await prisma.$disconnect();
}
