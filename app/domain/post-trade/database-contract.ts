import { liveMigrationChecksums } from '../workflow/live-database-contract.js';
export const postTradeProfile = 'owned-posttrade-v1' as const;
export const postTradeMigrationChecksums: ReadonlyArray<{ version: number; checksum: string }> = [
  ...liveMigrationChecksums,
  { version: 10, checksum: '864cb3d9e1e945bfdff609ddeedf09b3331100d313b06d316ab6f246de4932ce' },
];
