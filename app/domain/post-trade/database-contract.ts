import { liveMigrationChecksums } from '../workflow/live-database-contract.js';
export const postTradeProfile = 'owned-posttrade-v1' as const;
export const postTradeMigrationChecksums: ReadonlyArray<{ version: number; checksum: string }> = [
  ...liveMigrationChecksums,
  { version: 10, checksum: '41cc71d917dd081a3d69127e9b5e0732221823070b367e030c57ba6cd8cb1649' },
];
