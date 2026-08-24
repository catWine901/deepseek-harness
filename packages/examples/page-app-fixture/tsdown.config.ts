import { clientBundle } from '../../client/tsdown.client.ts'

/**
 * The page-app fixture ships a host half (lib/index.js + invariant) and a
 * browser surface bundle (lib/client.js), matching every dsh.client package:
 * the Node half is composed by the Workbench Runtime wrapper (M7), the client
 * half is the keyed surface contribution served through exports["./client"].
 */
export default clientBundle(
  '@deepseek-ai/dsh-page-app-fixture',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
