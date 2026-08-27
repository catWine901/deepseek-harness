import { clientBundle } from '../tsdown.client.ts'

const moduleId = process.env.DSH_PAGE_APP_MANAGER_CLIENT_MODULE_ID
  ?? '@deepseek-ai/dsh-client-ui-page-app-manager'
const legacyRc2Client = process.env.DSH_PAGE_APP_MANAGER_CLIENT_MODULE_ID !== undefined

export default clientBundle(
  '@deepseek-ai/dsh-client-ui-page-app-manager',
  ['lib/types/index.js', 'lib/types/invariant.js'],
  {
    moduleId,
    clientDefines: {
      'process.env.DSH_CLIENT_PAGE_APP_MANAGER_LEGACY_RC2': JSON.stringify(legacyRc2Client ? 'true' : 'false'),
    },
  },
)
