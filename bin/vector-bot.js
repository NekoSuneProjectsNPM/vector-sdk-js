#!/usr/bin/env node
import { main } from '../dist/cli.js';

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
