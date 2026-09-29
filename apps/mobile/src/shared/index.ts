// Single source of truth shared with the backend (MASTER_PROMPT §4): domain types/copy and xStock amount math.
// These packages have no runtime dependencies, so Metro bundles them directly (see metro.config.js watchFolders).
export * from '../../../../packages/domain/src/index'
export {
  multiplierToFraction,
  rawToUiShares,
  ScaledUiError,
  uiSharesToRawFloor,
} from '../../../../packages/xstocks/src/index'
