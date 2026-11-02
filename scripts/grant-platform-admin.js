'use strict';

/**
 * Grants (or revokes with --revoke) the platform super-admin flag.
 * This is intentionally CLI-only: there is no API to create platform admins.
 *   npm run platform:grant-admin -- someone@example.com [--revoke]
 */
const { User, PlatformAuditLog, sequelize } = require('../src/models');

(async () => {
  const email = (process.argv[2] || '').toLowerCase();
  const revoke = process.argv.includes('--revoke');
  if (!email) throw new Error('Usage: npm run platform:grant-admin -- <email> [--revoke]');
  const user = await User.findOne({ where: { email } });
  if (!user) throw new Error(`No user with email ${email}`);
  await user.update({ is_platform_admin: !revoke });
  await PlatformAuditLog.create({ actor_user_id: null, action: revoke ? 'platform_admin.revoked' : 'platform_admin.granted', summary: `${email} via CLI by ${process.env.USER || 'unknown'}` });
  console.log(`${email} is ${revoke ? 'no longer' : 'now'} a platform administrator.${revoke ? '' : ' MFA is required in production.'}`);
  await sequelize.close();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
