-- Owner corrections to Vietnamese names, shared by the family. They are given to the AI as examples and, for an exact
-- repeat of a name, used directly. from_text = to_text means "leave this name alone".
CREATE TABLE name_corrections (
  family_id TEXT NOT NULL REFERENCES families(id),
  from_text TEXT NOT NULL,
  to_text TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (family_id, from_text)
);
