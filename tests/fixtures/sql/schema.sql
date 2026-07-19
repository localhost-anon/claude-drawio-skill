-- schema for a small blog app
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE app.users (
  id INTEGER PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  UNIQUE (email)
);

CREATE TABLE app.posts (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  author_id INTEGER REFERENCES app.users(id),
  CONSTRAINT fk_editor FOREIGN KEY (editor_id) REFERENCES app.users (id)
);

CREATE TABLE IF NOT EXISTS "app"."comments" (
  id INTEGER,
  post_id INTEGER NOT NULL,
  body TEXT,
  PRIMARY KEY (id),
  FOREIGN KEY (post_id) REFERENCES app.posts(id)
);
