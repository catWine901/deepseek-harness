/** Release-only, tree-shakeable profile-runtime surface for the standalone manager. */

export {
  canonicalManagedRootHash,
  composeProfilePatches,
  managedRootWrapperId,
  managedRootWrapperRow,
  managerWrapperResolvable,
  prepareManagerRuntimeLayer,
  PROFILE_RUNTIME_SERVICE,
  ProfileRuntime,
  profileRuntimeControl,
  readManagerLayerPatches,
  WORKBENCH_RUNTIME_SERVICE,
  type ProfileRuntimeApplyRequest,
  type ProfileRuntimeApplyResult,
  type ExpectedManagedRoot,
} from './profile-runtime.ts'
export { loadOptionalPatches, loadOverlayPatches } from './patches.ts'
