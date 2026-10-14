const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const connect = require('./connect');

/**
 * Manages the host-mode tenant registry. All logic lives in `@librechat/api` (`runTenantCommand`);
 * this file only connects to the database and supplies the dependencies.
 *
 *   node config/tenant.js create --tenant-id <id> --slug <slug> --client-id <id>
 *
 * The OIDC client secret comes from TENANT_OIDC_CLIENT_SECRET or stdin, never from an argument.
 */
async function readSecret() {
  const fromEnv = process.env.TENANT_OIDC_CLIENT_SECRET?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (process.stdin.isTTY) {
    return undefined;
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim() || undefined;
}

(async () => {
  try {
    await connect();
    const { runTenantCommand, encryptV3 } = require('@librechat/api');
    const methods = require('~/models');

    const code = await runTenantCommand(process.argv.slice(2), {
      methods,
      encryptSecret: encryptV3,
      readSecret,
      env: process.env,
      print: (line) => console.log(line),
      printError: (line) => console.error(line),
    });
    process.exit(code);
  } catch (err) {
    console.error('Tenant command failed:', err.message);
    process.exit(1);
  }
})();
