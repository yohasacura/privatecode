/**
 * Claude Code's plugin system, in PrivateCode (docs/PLUGINS-2026-09.md). One import for the
 * host, the REPL and the tests.
 */
export * from './manifest.js'
export * from './store.js'
export * from './settings.js'
export {
  parseMarketplaceSource, describeMarketplaceSource, gitAvailable, cloneRepo, updateClone, copyTree, hashTree,
} from './sources.js'
export * from './marketplaces.js'
export * from './installer.js'
export * from './command.js'
