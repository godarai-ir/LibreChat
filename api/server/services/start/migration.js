const mongoose = require('mongoose');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const {
  logAgentMigrationWarning,
  logPromptMigrationWarning,
  checkAgentPermissionsMigration,
  checkPromptPermissionsMigration,
} = require('@librechat/api');
const { findRoleByIdentifier } = require('~/models');

/**
 * Check if permissions migrations are needed for shared resources
 * This runs at the end to ensure all systems are initialized. It counts every tenant's
 * resources, so it runs in a system context: strict tenant isolation refuses it otherwise.
 */
function checkMigrations() {
  return runAsSystem(checkMigrationsUnscoped);
}

async function checkMigrationsUnscoped() {
  try {
    const agentMigrationResult = await checkAgentPermissionsMigration({
      mongoose,
      methods: {
        findRoleByIdentifier,
      },
      AgentModel: mongoose.models.Agent,
    });
    logAgentMigrationWarning(agentMigrationResult);
  } catch (error) {
    logger.error('Failed to check agent permissions migration:', error);
  }
  try {
    const promptMigrationResult = await checkPromptPermissionsMigration({
      mongoose,
      methods: {
        findRoleByIdentifier,
      },
      PromptGroupModel: mongoose.models.PromptGroup,
    });
    logPromptMigrationWarning(promptMigrationResult);
  } catch (error) {
    logger.error('Failed to check prompt permissions migration:', error);
  }
}

module.exports = {
  checkMigrations,
};
