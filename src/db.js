import { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const pool = new Pool({
  connectionString: process.env.COMM_DB_URL,
  host: process.env.COMM_DB_HOST,
  port: process.env.COMM_DB_PORT ? Number(process.env.COMM_DB_PORT) : undefined,
  database: process.env.COMM_DB_NAME,
  user: process.env.COMM_DB_USER,
  password: process.env.COMM_DB_PASSWORD,
  max: 10
});

export async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } catch (err) {
    logger.error({ err, text }, 'db query error');
    throw err;
  } finally {
    client.release();
  }
}

export { pool };


