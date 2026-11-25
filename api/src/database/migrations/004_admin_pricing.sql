CREATE TABLE IF NOT EXISTS platform_settings (
  key varchar(80) PRIMARY KEY,
  value_int bigint NOT NULL CHECK(value_int >= 0),
  updated_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_settings_commission_limit CHECK(key <> 'default_commission_bps' OR value_int <= 10000)
);
INSERT INTO platform_settings(key,value_int) VALUES('default_commission_bps',1000) ON CONFLICT(key) DO NOTHING;
UPDATE regions SET delivery_fee_rial=500000 WHERE slug='bandar-khamir' AND delivery_fee_rial IS NULL;
