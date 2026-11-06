import type pg from 'pg';
import { DomainError } from '../../domain/errors.js';

export const publicProfileChecksum =
  'c3cddf384dfc39920d9cc30021d30cd106816953ee3dccba4f685ea1810149b6';

export async function verifyPublicProfile(db: pg.PoolClient | pg.Client): Promise<void> {
  const result = await db.query<{
    profile_name: string;
    profile_version: number;
    source_checksum: string;
    correct_database: boolean;
  }>(
    `SELECT profile_name,profile_version,source_checksum,
      database_name=current_database() AS correct_database
      FROM fi_control.public_demo_profile WHERE singleton`,
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row?.profile_name !== 'public-workflow-v1' ||
    row.profile_version !== 1 ||
    row.source_checksum !== publicProfileChecksum ||
    !row.correct_database
  )
    throw new DomainError(
      503,
      'PUBLIC_DEMO_PROFILE_UNAVAILABLE',
      'Public demo persistence is unavailable.',
    );
}
