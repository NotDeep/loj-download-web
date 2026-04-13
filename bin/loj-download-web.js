#!/usr/bin/env node

require('@hydrooj/register')
require('../server.ts').startServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
