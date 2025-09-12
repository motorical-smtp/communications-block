-- Add 'clicked' event type to email_events table
-- This enables click tracking for customer link analytics

-- Drop the existing constraint
ALTER TABLE email_events DROP CONSTRAINT email_events_type_check;

-- Add the new constraint with 'clicked' included
ALTER TABLE email_events ADD CONSTRAINT email_events_type_check 
  CHECK (type::text = ANY (ARRAY[
    'queued'::character varying, 
    'sending'::character varying, 
    'sent'::character varying, 
    'delivered'::character varying, 
    'bounced'::character varying, 
    'complained'::character varying, 
    'failed'::character varying, 
    'blocked'::character varying,
    'clicked'::character varying
  ]::text[]));

-- Grant permissions
GRANT ALL PRIVILEGES ON email_events TO motorical;
