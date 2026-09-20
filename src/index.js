'use strict';

const buildApp = require('./app');

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

buildApp()
  .listen({ port, host })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
