module.exports = {
  apps: [
    {
      name: "resume-bot",
      script: "index.js",
      watch: false,
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: "10s",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
