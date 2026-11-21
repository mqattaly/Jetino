-- Historical refunds were recorded without a destination and may already have been paid out.
-- Never invent a wallet balance from those rows. New wallet refunds are explicitly marked.
ALTER TABLE order_refunds ADD COLUMN IF NOT EXISTS destination varchar(16) NOT NULL DEFAULT 'EXTERNAL';
ALTER TABLE order_refunds ADD CONSTRAINT order_refunds_destination_check CHECK (destination IN ('EXTERNAL', 'WALLET'));
CREATE INDEX IF NOT EXISTS order_refunds_wallet_order_idx ON order_refunds(order_id, created_at DESC, id DESC) WHERE destination = 'WALLET';

ALTER TABLE order_refunds ADD COLUMN request_key uuid;
CREATE UNIQUE INDEX order_refunds_request_key_idx ON order_refunds(order_id, request_key) WHERE request_key IS NOT NULL;
