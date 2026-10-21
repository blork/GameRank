-- npx wrangler d1 execute gamerank --remote --file schema.sql
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY, account TEXT NOT NULL, public_key TEXT NOT NULL,
  counter INTEGER NOT NULL, transports TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, challenge TEXT NOT NULL, account TEXT, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, account TEXT NOT NULL, expires INTEGER NOT NULL); -- token is a SHA-256 hash
CREATE TABLE IF NOT EXISTS lists (account TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL);
