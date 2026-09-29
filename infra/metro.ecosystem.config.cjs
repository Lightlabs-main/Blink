// Development-only Metro server for the Blink dev-client build. Start only while testing:
//   pm2 start infra/metro.ecosystem.config.cjs   |   pm2 stop blink-metro
// It serves the app's JS bundle (public code, public Privy IDs only). Never run `pm2 * all`.
const path = require('node:path')

module.exports = {
  apps: [
    {
      name: 'blink-metro',
      cwd: path.resolve(__dirname, '../apps/mobile'),
      script: 'node_modules/expo/bin/cli',
      args: 'start --dev-client --port 8095',
      interpreter: 'node',
      autorestart: false,
      max_memory_restart: '1200M',
      env: {
        CI: '1',
        EXPO_NO_TELEMETRY: '1',
        // Public address the phone uses to reach this dev server (set on the server, not committed).
        REACT_NATIVE_PACKAGER_HOSTNAME: process.env.BLINK_METRO_HOST || '127.0.0.1',
      },
    },
  ],
}
