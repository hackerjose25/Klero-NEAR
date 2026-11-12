// Loads backend/.env when it exists; silent when it doesn't (all NEAR settings are optional).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(file)) process.loadEnvFile(file);
