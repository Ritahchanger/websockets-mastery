// examples/12-production/ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'huddle-sfu',
    script: 'server.js',
    cwd: '/opt/huddle',
    exec_mode: 'fork',       // NOT 'cluster': each mediasoup Node process owns its workers & rooms;
    instances: 1,            // PM2 cluster round-robins connections → peers of one room land in different processes.
    kill_timeout: 60000,     // give SIGTERM drain time
    max_memory_restart: '2G',
    env: { NODE_ENV: 'production', MEDIASOUP_NUM_WORKERS: '4' },
  }],
};
