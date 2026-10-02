// D-24: Android push needs Firebase's google-services.json. It is not committed (public repo): EAS provides it as the
// GOOGLE_SERVICES_JSON file variable, and a local copy at ./google-services.json also works. Without it the app still
// builds and runs; notifications are simply unavailable.
const fs = require('node:fs')
const path = require('node:path')

module.exports = ({ config }) => {
  const local = path.join(__dirname, 'google-services.json')
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON ?? (fs.existsSync(local) ? './google-services.json' : undefined)
  return {
    ...config,
    android: { ...config.android, ...(googleServicesFile ? { googleServicesFile } : {}) },
  }
}
