// The previous seeder impersonated multiple members through anonymous RPCs.
// Account-enabled groups require a verified identity for each member.
console.error('Anonymous demo seeding is disabled. Use npm test / npm run check:accounts-ui for isolated fixtures, or create a group with signed-in test accounts.');
process.exitCode = 1;
