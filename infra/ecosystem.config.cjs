// PM2 config for Blink only. Operate by name: `pm2 start infra/ecosystem.config.cjs`, `pm2 restart blink-api`.
// Never use `pm2 restart|stop|delete all` on the shared VPS.
const path = require('node:path')

module.exports = {
  apps: [
    {
      name: 'blink-api',
      cwd: path.resolve(__dirname, '..'),
      script: 'apps/api/src/main.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '350M',
      autorestart: true,
      env: { NODE_ENV: 'production' },
    },
  ],
}
