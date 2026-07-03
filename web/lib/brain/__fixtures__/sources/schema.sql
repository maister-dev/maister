CREATE TABLE tasks (
  id text PRIMARY KEY,
  title text NOT NULL
);

CREATE INDEX tasks_title_idx ON tasks (title);
