module.exports = {
  apps: [
    {
      name: 'a11y-inspector',
      script: 'server.js',
      cwd: '/home/user/webapp',
      interpreter: 'node',
      // 코어덤프 비활성화(ulimit -c 0) + Node.js 힙 제한 512MB
      interpreter_args: '--experimental-vm-modules --max-old-space-size=512',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork',

      // ── 자동 재시작 설정 ──────────────────────────────
      autorestart: true,          // 크래시 시 자동재시작 (기본값이지만 명시)
      restart_delay: 2000,        // 재시작 전 2초 대기
      max_restarts: 999,          // 사실상 무제한 재시작
      min_uptime: '5s',           // 5초 이상 살아있어야 "정상 시작"으로 인정

      // ── 메모리 초과 시 자동 재시작 ───────────────────
      max_memory_restart: '700M', // 700MB 초과 시 자동 재시작 (RAM 987MB 기준)

      // ── 로그 설정 ─────────────────────────────────────
      error_file: '/home/user/webapp/logs/err.log',
      out_file:   '/home/user/webapp/logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      // ── 코어덤프 비활성화 (환경변수로 ulimit 설정) ───
      kill_timeout: 5000,         // 강제종료 전 5초 대기
      node_args: []
    }
  ]
}
