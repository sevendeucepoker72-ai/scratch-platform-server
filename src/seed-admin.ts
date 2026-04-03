// Seed script — creates an admin user for local development
// Usage: cd server && npm run seed:admin

import { auth } from './auth.js';
import { prisma } from './db.js';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'josh2016hall@hotmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '13811admin';
const ADMIN_NAME = 'Josh (Admin)';

async function main() {
  console.log('[seed] Creating admin user...');

  // Check if app user already exists
  const existing = await prisma.appUser.findUnique({ where: { email: ADMIN_EMAIL } });
  if (existing) {
    console.log(`[seed] User ${ADMIN_EMAIL} already exists with role: ${existing.role}`);
    // Ensure role is super_admin
    if (existing.role !== 'super_admin') {
      await prisma.appUser.update({ where: { id: existing.id }, data: { role: 'super_admin' } });
      console.log('[seed] Upgraded to super_admin');
    }
    await prisma.$disconnect();
    return;
  }

  // Create Better Auth user
  let authUser;
  try {
    const result = await auth.api.signUpEmail({
      body: {
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        name: ADMIN_NAME,
      },
    });
    authUser = result.user;
    console.log(`[seed] Auth user created: ${authUser.id}`);
  } catch (err: any) {
    // User might already exist in auth but not in app users table
    console.log('[seed] Auth user may already exist, attempting to find...');
    const sessions = await auth.api.signInEmail({
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    authUser = sessions.user;
    console.log(`[seed] Found existing auth user: ${authUser.id}`);
  }

  // Create app user record
  const user = await prisma.appUser.create({
    data: {
      authId: authUser.id,
      email: ADMIN_EMAIL,
      displayName: ADMIN_NAME,
      role: 'super_admin',
      venueIds: '[]',
      isActive: true,
    },
  });

  console.log('[seed] Admin user created successfully!');
  console.log(`  ID:    ${user.id}`);
  console.log(`  Email: ${ADMIN_EMAIL}`);
  console.log(`  Role:  super_admin`);
  console.log(`  Password: ${ADMIN_PASSWORD}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[seed] Failed:', err);
  process.exit(1);
});
