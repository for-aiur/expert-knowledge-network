ALTER TABLE users ADD COLUMN password_scheme TEXT NOT NULL DEFAULT 'pbkdf2-sha256'
  CHECK (password_scheme IN ('pbkdf2-sha256', 'pbkdf2-sha256-chain-v1'));
