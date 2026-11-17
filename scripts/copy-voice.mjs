import { cpSync } from 'node:fs';
cpSync(new URL('../src/voice/runtime/', import.meta.url), new URL('../dist/src/voice/runtime/', import.meta.url), { recursive: true });
