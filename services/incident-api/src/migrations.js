import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function migrationMetadata(fileName, sql) {
  const match = fileName.match(/^(\d+)_(.+)\.sql$/);
  if (!match) {
    throw new Error(`Invalid migration filename: ${fileName}`);
  }

  return {
    version: match[1],
    name: match[2],
    checksum: crypto.createHash("sha256").update(sql).digest("hex")
  };
}

export async function runMigrations(pool, migrationsDir) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const migrationFiles = fs.readdirSync(migrationsDir)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();

  for (const fileName of migrationFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, fileName), "utf8");
    const migration = migrationMetadata(fileName, sql);
    const applied = await pool.query(
      "SELECT checksum FROM schema_migrations WHERE version = $1",
      [migration.version]
    );

    if (applied.rows[0]) {
      if (applied.rows[0].checksum !== migration.checksum) {
        throw new Error(`Migration checksum mismatch for ${fileName}`);
      }
      continue;
    }

    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query(
        "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
        [migration.version, migration.name, migration.checksum]
      );
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }
}
