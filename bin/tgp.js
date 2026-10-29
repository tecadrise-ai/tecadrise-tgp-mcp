#!/usr/bin/env node
import { main } from '../src/cli.js';
process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(0); throw e; });
await main(process.argv.slice(2));
