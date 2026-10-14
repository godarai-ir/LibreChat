const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const mongoose = require('mongoose');
const connect = require('./connect');

/**
 * Moves an existing single-tenant deployment into host mode by giving every untenanted row to
 * one tenant. Logic lives in `@librechat/data-schemas` (`assignTenantToUntenantedRows`) and
 * `@librechat/api` (`runAssignTenantCommand`); this file only connects and supplies them.
 *
 *   node config/assign-tenant.js --tenant-id <id>            # dry run
 *   node config/assign-tenant.js --tenant-id <id> --apply    # write
 */
(async () => {
  try {
    await connect();
    const { assignTenantToUntenantedRows } = require('@librechat/data-schemas');
    const { runAssignTenantCommand } = require('@librechat/api');
    const { getTenantById } = require('~/models');

    const code = await runAssignTenantCommand(process.argv.slice(2), {
      assign: (options) => assignTenantToUntenantedRows(mongoose, options),
      getTenantById,
      print: (line) => console.log(line),
      printError: (line) => console.error(line),
    });
    process.exit(code);
  } catch (err) {
    console.error('Assigning the tenant failed:', err.message);
    process.exit(1);
  }
})();
