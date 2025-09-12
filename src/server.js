import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { Pool } from 'pg';
import listsRouter from './routes/lists.js';
import templatesRouter from './routes/templates.js';
import campaignsRouter from './routes/campaigns.js';
import trackingRouter from './routes/tracking.js';
import provisioningRouter from './routes/provisioning.js';
import webhooksRouter from './routes/webhooks.js';
import suppressionsRouter from './routes/suppressions.js';
import recipientsRouter from './routes/recipients.js';
import analyticsRouter from './routes/analytics.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Database pool
const pool = new Pool({
  connectionString: process.env.COMM_DB_URL,
  host: process.env.COMM_DB_HOST,
  port: process.env.COMM_DB_PORT ? Number(process.env.COMM_DB_PORT) : undefined,
  database: process.env.COMM_DB_NAME,
  user: process.env.COMM_DB_USER,
  password: process.env.COMM_DB_PASSWORD,
  max: 10
});

async function healthCheckDb() {
  try {
    const r = await pool.query('SELECT 1 as ok');
    return r.rows?.[0]?.ok === 1;
  } catch (e) {
    logger.error({ err: e }, 'db health failed');
    return false;
  }
}

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(pinoHttp({ logger }));

app.get('/api/health', async (req, res) => {
  const dbOk = await healthCheckDb();
  res.json({ success: true, data: { status: 'ok', db: dbOk } });
});

app.use('/api', listsRouter);
app.use('/api', templatesRouter);
app.use('/api', campaignsRouter);
app.use('/api', recipientsRouter);
app.use('/api', analyticsRouter);
app.use('/api', provisioningRouter);
app.use('/api/suppressions', suppressionsRouter);
app.use('/', webhooksRouter);
app.use('/', trackingRouter);

const port = Number(process.env.COMM_PORT || 3011);
app.listen(port, () => {
  logger.info({ port }, 'communications-block api started');
});

export { pool };


