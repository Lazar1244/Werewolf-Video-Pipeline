-- 001_init: full schema from ARCHITECTURE.md §10.
-- JSON columns hold zod-validated payloads (see @ww/shared).

-- A row starts as a lobby (editable draft in lobby_json, no frozen config yet).
-- At game start the frozen config, seed and engine version are written and the
-- status leaves 'lobby' (enforced by the CHECK below).
CREATE TABLE games (
  id               TEXT PRIMARY KEY,
  created_at       TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('lobby','running','paused','over_offer','debrief','over','aborted')),
  pause_reason     TEXT CHECK (pause_reason IN ('host','cost_cap','provider_failure','humans_disconnected','recovered','version_mismatch','corrupt')),
  paused_from      TEXT CHECK (paused_from IN ('running','over_offer','debrief')),
  lobby_json       TEXT,
  config_json      TEXT,
  seed             TEXT,
  engine_version   TEXT,
  started_at       TEXT,
  prompt_pack_hash TEXT,
  winner_team      TEXT,
  ended_reason     TEXT,
  cost_spent_usd   REAL NOT NULL DEFAULT 0 CHECK (cost_spent_usd >= 0),
  cost_cap_usd     REAL NOT NULL CHECK (cost_cap_usd > 0),
  has_bot          INTEGER NOT NULL DEFAULT 0 CHECK (has_bot IN (0,1)),
  has_remap        INTEGER NOT NULL DEFAULT 0 CHECK (has_remap IN (0,1)),
  lock_open        INTEGER NOT NULL DEFAULT 0 CHECK (lock_open IN (0,1)),
  -- started games carry the frozen snapshot; only lobbies (and lobbies aborted before start) may lack it
  CHECK (
    (status IN ('lobby','aborted') AND started_at IS NULL)
    OR (config_json IS NOT NULL AND seed IS NOT NULL AND engine_version IS NOT NULL AND started_at IS NOT NULL)
  ),
  -- a lobby is a draft only
  CHECK (status <> 'lobby' OR (lobby_json IS NOT NULL AND config_json IS NULL AND started_at IS NULL)),
  -- pause bookkeeping exists exactly while paused
  CHECK ((status = 'paused') = (pause_reason IS NOT NULL)),
  CHECK ((status = 'paused') = (paused_from IS NOT NULL))
);

-- One row per lobby slot. seat/display_name are filled at game start (seeded shuffle);
-- final_* are filled at game over and feed role/model statistics.
CREATE TABLE slots (
  game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  slot         INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 10),
  seat         INTEGER CHECK (seat BETWEEN 1 AND 10),
  display_name TEXT,
  controller   TEXT NOT NULL CHECK (controller IN ('ai','human','bot')),
  human_name   TEXT,
  final_role   TEXT,
  final_team   TEXT,
  won          INTEGER CHECK (won IN (0,1)),
  PRIMARY KEY (game_id, slot)
);
CREATE UNIQUE INDEX slots_seat ON slots(game_id, seat) WHERE seat IS NOT NULL;

-- Browser sessions (ARCHITECTURE.md §9.1). Only hashes of tokens/codes are stored.
CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  game_id           TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  principal         TEXT NOT NULL CHECK (principal IN ('seat','spectator')),
  slot              INTEGER CHECK (slot BETWEEN 1 AND 10),
  join_token_hash   TEXT UNIQUE,          -- one-time link token; NULL once burned
  cookie_hash       TEXT UNIQUE,          -- session cookie; NULL until the link is used
  rejoin_code_hash  TEXT,
  created_at        TEXT NOT NULL,
  used_at           TEXT,
  revoked_at        TEXT,
  CHECK (principal = 'spectator' OR slot IS NOT NULL)
);

CREATE TABLE seat_profiles (
  game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seat         INTEGER NOT NULL CHECK (seat BETWEEN 1 AND 10),
  from_eseq    INTEGER NOT NULL CHECK (from_eseq >= 0),
  profile_json TEXT NOT NULL,
  PRIMARY KEY (game_id, seat, from_eseq)
);

CREATE TABLE engine_events (
  game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  eseq         INTEGER NOT NULL CHECK (eseq >= 1),
  type         TEXT NOT NULL,
  vis_json     TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  at_json      TEXT NOT NULL,
  PRIMARY KEY (game_id, eseq)
);

CREATE TABLE meta_events (
  game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  mseq         INTEGER NOT NULL CHECK (mseq >= 1),
  wall_time    TEXT NOT NULL,
  type         TEXT NOT NULL,
  vis          TEXT NOT NULL CHECK (vis IN ('host_safe','host_full','spectator')),
  payload_json TEXT NOT NULL,
  PRIMARY KEY (game_id, mseq)
);

CREATE TABLE requests (
  game_id           TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  internal_id       INTEGER NOT NULL CHECK (internal_id >= 1),
  client_id         TEXT NOT NULL UNIQUE,
  seat              INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 10), -- 0 = host pseudo-addressee
  kind              TEXT NOT NULL,
  legal_json        TEXT NOT NULL,
  group_id          INTEGER NOT NULL CHECK (group_id >= 1),
  opened_eseq       INTEGER NOT NULL CHECK (opened_eseq >= 1),
  deadline_at       TEXT,
  delivered_at      TEXT,
  attempt_state     TEXT NOT NULL DEFAULT 'initial' CHECK (attempt_state IN ('initial','repair','answered')),
  last_invalid_json TEXT,
  PRIMARY KEY (game_id, internal_id),
  UNIQUE (game_id, internal_id, seat)
);

CREATE TABLE decisions (
  game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  internal_id INTEGER NOT NULL CHECK (internal_id >= 1),
  seat        INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 10),
  answer_json TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('model','human','bot','fallback')),
  repair_used INTEGER NOT NULL DEFAULT 0 CHECK (repair_used IN (0,1)),
  status      TEXT NOT NULL CHECK (status IN ('buffered','applied')),
  apply_order INTEGER CHECK (apply_order >= 1),
  PRIMARY KEY (game_id, internal_id),
  FOREIGN KEY (game_id, internal_id, seat) REFERENCES requests(game_id, internal_id, seat) ON DELETE CASCADE
);
CREATE UNIQUE INDEX decisions_apply_order ON decisions(game_id, apply_order) WHERE apply_order IS NOT NULL;

CREATE TABLE llm_calls (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id           TEXT REFERENCES games(id) ON DELETE CASCADE,
  internal_id       INTEGER CHECK (internal_id >= 1),
  seat              INTEGER CHECK (seat BETWEEN 0 AND 10),
  profile_alias     TEXT NOT NULL,
  openrouter_id     TEXT NOT NULL,
  generation_id     TEXT,
  attempt           INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 20),
  purpose           TEXT NOT NULL CHECK (purpose IN ('initial','repair','probe','ping')),
  status            TEXT NOT NULL CHECK (status IN ('sent','ok','error','timeout','unknown')),
  queue_ms          INTEGER CHECK (queue_ms >= 0),
  latency_ms        INTEGER CHECK (latency_ms >= 0),
  prompt_tokens     INTEGER CHECK (prompt_tokens >= 0),
  completion_tokens INTEGER CHECK (completion_tokens >= 0),
  reasoning_tokens  INTEGER CHECK (reasoning_tokens >= 0),
  cached_tokens     INTEGER CHECK (cached_tokens >= 0),
  cost_usd          REAL CHECK (cost_usd >= 0),
  cost_source       TEXT CHECK (cost_source IN ('usage','generation','estimate','reserved')),
  reserved_usd      REAL NOT NULL CHECK (reserved_usd >= 0),
  request_json      TEXT,
  response_json     TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX llm_calls_game ON llm_calls(game_id, internal_id);

CREATE TABLE human_submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  internal_id  INTEGER NOT NULL CHECK (internal_id >= 1),
  seat         INTEGER NOT NULL CHECK (seat BETWEEN 1 AND 10),
  payload_json TEXT NOT NULL,
  accepted     INTEGER NOT NULL CHECK (accepted IN (0,1)),
  issues_json  TEXT,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (game_id, internal_id, seat) REFERENCES requests(game_id, internal_id, seat) ON DELETE CASCADE
);

CREATE TABLE human_notes (
  game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seat       INTEGER NOT NULL CHECK (seat BETWEEN 1 AND 10),
  text       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (game_id, seat)
);

CREATE TABLE prompt_packs (
  hash         TEXT PRIMARY KEY,
  content_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE model_catalog (
  openrouter_id  TEXT PRIMARY KEY,
  fetched_at     TEXT NOT NULL,
  data_json      TEXT NOT NULL,
  endpoints_json TEXT
);
