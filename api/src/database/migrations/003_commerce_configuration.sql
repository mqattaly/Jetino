ALTER TABLE regions ADD COLUMN IF NOT EXISTS delivery_fee_rial bigint CHECK(delivery_fee_rial IS NULL OR delivery_fee_rial >= 0);
ALTER TABLE businesses ALTER COLUMN commission_bps DROP NOT NULL;
ALTER TABLE businesses ALTER COLUMN commission_bps DROP DEFAULT;
INSERT INTO regions(name,slug,is_active) VALUES('بندر خمیر','bandar-khamir',true) ON CONFLICT(slug) DO NOTHING;
