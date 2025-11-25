import { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const pool = new Pool({
  connectionString: process.env.MOTORICAL_DB_URL,
  host: process.env.MOTORICAL_DB_HOST,
  port: process.env.MOTORICAL_DB_PORT ? Number(process.env.MOTORICAL_DB_PORT) : undefined,
  database: process.env.MOTORICAL_DB_NAME,
  user: process.env.MOTORICAL_DB_USER,
  password: process.env.MOTORICAL_DB_PASSWORD,
  max: 10
});

export async function motoricalQuery(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } catch (err) {
    logger.error({ err, text }, 'motorical db query error');
    throw err;
  } finally {
    client.release();
  }
}

export { pool as motoricalPool };


