module.exports = {
  apps: [
    {
      name: 'a11y-inspector',
      script: 'server.js',
      cwd: '/home/user/webapp',
      interpreter: 'node',
      interpreter_args: '--experimental-vm-modules',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
      error_file: '/home/user/webapp/logs/err.log',
      out_file: '/home/user/webapp/logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    }
  ]
}
