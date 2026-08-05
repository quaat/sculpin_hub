// Placeholder overwritten by `pnpm prisma:generate`.
export class PrismaClient {
  constructor() {
    throw new Error(
      "Prisma Client has not been generated. Run pnpm prisma:generate.",
    );
  }
  $disconnect() {
    return Promise.resolve();
  }
}
